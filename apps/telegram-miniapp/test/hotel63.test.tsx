/**
 * Fix 6.3: hotel settings — guest rating, distance to the venue, stars. Profile «Поездки → Отель» (PATCH hotel_prefs),
 * the trip «Настроить расчёт» (POST …/recalculate hotel_filters over the profile, «как в профиле» / «изменено»),
 * «По вашим условиям (до 1 км, оценка от 9,0) отелей нет — показываем ближайшие варианты» and the hotel tags.
 */
import type { OfferSetView, Preferences, Profile } from "@tilhero/contracts/bff";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as F from "../e2e/fixtures/data";
import { buildOfferSet, type OfferBuildOpts } from "../e2e/fixtures/offers";
import type { Api } from "../src/api/endpoints";
import { ApiError } from "../src/api/errors";
import { I18nProvider, translate, type Lang } from "../src/i18n";
import { TripBlock, TripBoundary } from "../src/screens/events/Trip";
import { PrefEditor } from "../src/screens/profile/PrefEditor";
import { Profile as ProfileScreen } from "../src/screens/profile/Profile";
import { AppContext, type AppCtx } from "../src/state/app";
import { draftFromPreferences, pickHotel, preferencesPatch } from "../src/state/prefs";
import { mainButtonStore } from "../src/tg";
import { ToastHost } from "../src/ui/overlays";
import { beyondBase, DEFAULT_PARAMS, filtersFallback, filtersOf, hasOverrides, hotelConditions, hotelValues, offersCall, pickTripHotel } from "../src/trip/logic";

afterEach(() => {
  cleanup();
});

const ABU63 = F.tripEvents()[9]!;
const TAS_ONLY = [{ airport_iata: "TAS", city: "Tashkent", country_code: "UZ" }];
const opts = (o: Partial<OfferBuildOpts> = {}): OfferBuildOpts => ({
  travellers: 1,
  departures: TAS_ONLY,
  flightPrefs: { direct: true, connecting: true, alternative_departure: true },
  overrides: {},
  seq: 9,
  ...o,
});
const abu63 = (f: OfferBuildOpts["hotelFilters"] = null) => buildOfferSet(ABU63, opts({ hotelFilters: f }));
const tr = (lang: Lang) => (k: Parameters<typeof translate>[1], v?: Record<string, string | number>) => translate(lang, k, v);
const CONFIG = { hotel_rating_min: 8.5 };
const HP = (o: Partial<Preferences["hotel_prefs"]> = {}): Preferences["hotel_prefs"] => ({ rating_min: null, max_distance_km: null, min_stars: null, ...o });

/* ================================================================ pure logic */

describe("fix 6.3: hotel settings — logic", () => {
  it("profile draft: the default chip is stored as null; PATCH carries hotel_prefs", () => {
    let d = draftFromPreferences({ ...F.filledPreferences(), hotel_prefs: HP({ rating_min: 9, max_distance_km: 1, min_stars: 4 }) });
    expect([d.hotelRating, d.hotelDistance, d.hotelStars]).toEqual([9, 1, 4]);
    d = pickHotel(d, "rating", 8.5, 8.5);
    d = pickHotel(d, "distance", 5, 8.5);
    d = pickHotel(d, "stars", 0, 8.5);
    expect(preferencesPatch(d, ["hotel"], 7)).toEqual({ hotel_prefs: { rating_min: null, max_distance_km: null, min_stars: null }, version: 7 });
    d = pickHotel(pickHotel(d, "rating", 0, 8.5), "distance", 15, 8.5);
    expect(preferencesPatch(d, ["hotel"]).hotel_prefs).toEqual({ rating_min: 0, max_distance_km: 15, min_stars: null });
    expect(preferencesPatch(d, ["budget"])).not.toHaveProperty("hotel_prefs");
  });

  it("trip settings: over the profile per field; the profile's value again drops the field; sent with POST", () => {
    const hp = HP({ rating_min: 9, max_distance_km: 1 });
    expect(hotelValues(hp, null, 8.5)).toEqual({ rating: 9, distance: 1, stars: 0 });
    expect(hotelValues(HP(), null, 8.5)).toEqual({ rating: 8.5, distance: 5, stars: 0 });
    let f = pickTripHotel(null, "max_distance_km", 15, 1);
    f = pickTripHotel(f, "rating_min", 7, 9);
    expect(f).toEqual({ max_distance_km: 15, rating_min: 7 });
    expect(hotelValues(hp, f, 8.5)).toEqual({ rating: 7, distance: 15, stars: 0 });
    expect(pickTripHotel(pickTripHotel(f, "max_distance_km", 1, 1), "rating_min", 9, 9)).toBeNull();
    const p = { ...DEFAULT_PARAMS, hotel_filters: f };
    expect(hasOverrides(p)).toBe(true);
    expect(offersCall(p)).toEqual({ method: "POST", body: { travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, hotel_filters: { max_distance_km: 15, rating_min: 7 } } });
    // unknown values never leave the block
    expect(filtersOf({ hotel_filters: { rating_min: 6.5, max_distance_km: 2, min_stars: 0 } })).toEqual({ min_stars: 0 });
    expect(offersCall({ ...DEFAULT_PARAMS, hotel_filters: { rating_min: 6.5 } })).toEqual({ method: "GET", travellers: 1 });
  });

  it("an older BFF rejects hotel_filters → the same calculation without them (GET when nothing else is set)", () => {
    const e422 = new ApiError(422, "VALIDATION_ERROR", "bad", { field: "hotel_filters" });
    const call = offersCall({ ...DEFAULT_PARAMS, hotel_filters: { max_distance_km: 15 } });
    expect(filtersFallback(call, e422)).toEqual({ method: "GET", travellers: 1 });
    const withDep = offersCall({ ...DEFAULT_PARAMS, departure_iata: "TAS", hotel_filters: { max_distance_km: 15 } });
    expect(filtersFallback(withDep, e422)).toEqual({ method: "POST", body: { travellers: 1, direct_only: false, near_venue: false, extra_nights: 0, departure_iata: "TAS" } });
    expect(filtersFallback(call, new ApiError(422, "VALIDATION_ERROR", "bad", { field: "travellers" }))).toBeNull();
    expect(filtersFallback(call, new ApiError(503, "OFFERS_UNAVAILABLE", "x", {}))).toBeNull();
  });

  it("the mock offers ladder: 1 km / 9.0 → nothing by the conditions, the closest; 15 km / 7.0 → more hotels, no note", () => {
    const strict = abu63({ rating_min: 9, max_distance_km: 1, min_stars: null });
    expect(strict.notes).toEqual(expect.arrayContaining(["HOTEL_SEARCH_WIDENED", "HOTEL_PREFS_NONE"]));
    expect(strict.hotel_search).toMatchObject({ base_radius_m: 1000, base_rating_min: "9.0", from_prefs: true, widened: true });
    const wide = abu63({ rating_min: 7, max_distance_km: 15, min_stars: null });
    expect(wide.notes).not.toContain("HOTEL_PREFS_NONE");
    expect(wide.notes).not.toContain("HOTEL_SEARCH_WIDENED");
    expect(wide.hotels_nearby.length).toBeGreaterThan(abu63().hotels_nearby.length);
    const t = tr("ru");
    expect(hotelConditions(strict.hotel_search!, "ru", t)).toBe("до 1 км, оценка от 9,0");
    expect(hotelConditions({ ...strict.hotel_search!, base_rating_min: "0.0", base_min_stars: 4 }, "en", tr("en"))).toBe("within 1 km, any rating, 4★+");
    expect(beyondBase({ distance_m: 600, rating: "9.2", stars: 3 }, { ...strict.hotel_search!, base_min_stars: 4 })).toEqual({ far: false, lowRating: false, lowStars: true });
  });
});

/* ================================================================ components */

const profile = (hp: Preferences["hotel_prefs"] = HP()): Profile => ({ preferences: { ...F.filledPreferences(), budget: { currency: "USD", preset: null, min: null, max: null, custom_amount: null }, departures: TAS_ONLY, hotel_prefs: hp } }) as unknown as Profile;

function renderTrip(offers: Partial<Api["offers"]>, o: { lang?: Lang; prof?: Profile } = {}) {
  const api = { offers, profile: {}, directory: { airports: async () => ({ items: [] }) } } as unknown as Api;
  const ctx = { api, navigate: vi.fn(), profile: o.prof ?? profile(), reloadProfile: vi.fn(async () => null), config: CONFIG } as unknown as AppCtx;
  return render(
    <I18nProvider initial={o.lang ?? "ru"}>
      <AppContext.Provider value={ctx}>
        <TripBoundary>
          <TripBlock ev={ABU63} />
        </TripBoundary>
      </AppContext.Provider>
    </I18nProvider>,
  );
}

describe("fix 6.3: trip — «По вашим условиям …» and «Настроить расчёт»", () => {
  it("1 km / 9.0 from the profile: one note with the conditions (no second «поиск расширен»), tags on the hotels", async () => {
    const set = abu63({ rating_min: 9, max_distance_km: 1, min_stars: null });
    renderTrip({ get: vi.fn(async () => set) }, { prof: profile(HP({ rating_min: 9, max_distance_km: 1 })) });
    await screen.findByTestId("trip-pass");
    const notes = screen.getByTestId("trip-notes");
    expect(within(notes).getByText("По вашим условиям (до 1 км, оценка от 9,0) отелей нет — показываем ближайшие варианты.")).toBeInTheDocument();
    expect(notes.querySelector('[data-note="HOTEL_SEARCH_WIDENED"]')).toBeNull();
    const yas = screen.getAllByTestId("trip-hotel").find((h) => h.getAttribute("data-hotel-id") === "lpad01")!;
    expect(within(yas).getByTestId("hotel-low")).toHaveTextContent("оценка ниже 9,0");
    const premier = screen.getAllByTestId("trip-hotel").find((h) => h.getAttribute("data-hotel-id") === "lpad07")!;
    expect(within(premier).getByTestId("hotel-far")).toHaveTextContent("дальше 1 км");
  });

  it("the trip's settings: chips → POST with hotel_filters, «изменено»; «Как в профиле» → back to GET", async () => {
    const get = vi.fn(async () => abu63());
    const recalculate = vi.fn(async (_id: string, body: { hotel_filters?: OfferBuildOpts["hotelFilters"] }) => abu63({ rating_min: null, max_distance_km: null, min_stars: null, ...body.hotel_filters }));
    renderTrip({ get, recalculate: recalculate as unknown as Api["offers"]["recalculate"] });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByTestId("trip-settings-toggle"));
    const box = screen.getByTestId("trip-hotel-set");
    expect(within(box).getByTestId("hotel-mark-distance")).toHaveTextContent("как в профиле");
    expect(within(box).getByRole("radio", { name: "5 км" })).toHaveAttribute("aria-checked", "true");
    expect(within(box).getByRole("button", { name: "8,5" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(box).getByRole("radio", { name: "15 км" }));
    fireEvent.click(within(box).getByRole("button", { name: "7,0" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalled());
    const body = recalculate.mock.calls.at(-1)![1];
    expect(body.hotel_filters).toEqual({ max_distance_km: 15, rating_min: 7 });
    await waitFor(() => expect(screen.getByTestId("trip-settings")).toHaveTextContent("отель: до 15 км, оценка от 7,0"));
    expect(within(screen.getByTestId("trip-hotel-set")).getByTestId("hotel-mark-distance")).toHaveTextContent("изменено");
    expect(within(screen.getByTestId("trip-hotel-set")).getByTestId("hotel-mark-stars")).toHaveTextContent("как в профиле");
    const gets = get.mock.calls.length;
    fireEvent.click(screen.getByTestId("trip-hotel-reset"));
    await waitFor(() => expect(get.mock.calls.length).toBe(gets + 1));
    expect(screen.queryByTestId("trip-hotel-reset")).toBeNull();
  });

  it("English: the conditions note and the marks", async () => {
    renderTrip({ get: vi.fn(async () => abu63({ rating_min: 9, max_distance_km: 1, min_stars: null })) }, { lang: "en", prof: profile(HP({ rating_min: 9, max_distance_km: 1 })) });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("No hotels meet your conditions (within 1 km, rated 9.0+) — showing the closest options.");
    fireEvent.click(screen.getByTestId("trip-settings-toggle"));
    expect(within(screen.getByTestId("trip-hotel-set")).getByTestId("hotel-mark-rating")).toHaveTextContent("as in the profile");
  });
});

describe("fix 6.3: profile «Поездки → Отель»", () => {
  const renderProfile = (prefs: Preferences, patch = vi.fn()) => {
    const setProfile = vi.fn();
    const prof = { ...profile(prefs.hotel_prefs), preferences: prefs } as Profile;
    const api = { profile: { preferences: patch }, directory: { interests: async () => ({ items: [] }), geographies: async () => ({ items: [] }) } } as unknown as Api;
    const ctx = { api, profile: prof, setProfile, reloadProfile: vi.fn(async () => prof), config: CONFIG } as unknown as AppCtx;
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={ctx}>
          <PrefEditor kind="hotel" onClose={() => undefined} />
        </AppContext.Provider>
      </I18nProvider>,
    );
    return { setProfile, patch };
  };

  it("the editor: rating segments, distance and stars chips; save → PATCH hotel_prefs with version", async () => {
    const prefs = { ...F.filledPreferences(), hotel_prefs: HP() };
    const patch = vi.fn(async (b: { hotel_prefs: Preferences["hotel_prefs"] }) => ({ ...prefs, hotel_prefs: b.hotel_prefs, version: 8 }));
    const { setProfile } = renderProfile(prefs, patch);
    const ed = screen.getByTestId("editor-hotel");
    expect(within(ed).getByRole("button", { name: "8,5" })).toHaveAttribute("aria-pressed", "true");
    expect(within(ed).getByTestId("hotel-rating-hint")).toHaveTextContent("Отели с оценкой гостей от 8,5. Так по умолчанию.");
    fireEvent.click(within(ed).getByRole("button", { name: "9,0" }));
    fireEvent.click(within(ed).getByRole("radio", { name: "1 км" }));
    fireEvent.click(within(ed).getByRole("radio", { name: "4★+" }));
    await act(async () => mainButtonStore.top()!.onClick());
    expect(patch).toHaveBeenCalledWith({ hotel_prefs: { rating_min: 9, max_distance_km: 1, min_stars: 4 }, version: 7 });
    expect(setProfile).toHaveBeenCalled();
  });

  it("Profile: «Поездки» lists budget, departures, flights and the hotel summary", async () => {
    const prefs = { ...F.filledPreferences(), hotel_prefs: HP({ rating_min: 9, max_distance_km: 1 }) };
    const prof = { user: F.user(), security: F.security(), consent: F.acceptedConsent(), preferences: prefs, notifications: F.notifications() } as unknown as Profile;
    const api = { profile: {}, directory: { interests: async () => ({ items: [] }), geographies: async () => ({ items: [] }) } } as unknown as Api;
    const ctx = {
      api,
      session: { user: prof.user, security: prof.security, consent: prof.consent },
      profile: prof,
      setProfile: vi.fn(),
      reloadProfile: vi.fn(async () => prof),
      config: { ...CONFIG, theme: { id: "dark-premium", version: "2.0.3" } },
      configSource: "local",
      navigate: vi.fn(),
      setSecurity: vi.fn(),
    } as unknown as AppCtx;
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={ctx}>
          <ProfileScreen />
        </AppContext.Provider>
      </I18nProvider>,
    );
    const trips = await screen.findByTestId("profile-trips");
    expect(within(trips).getAllByRole("button").map((b) => b.querySelector("b")?.textContent)).toEqual(["Бюджет на 1 человека", "Города вылета", "Рейсы", "Отель"]);
    expect(within(trips).getByTestId("pref-row-hotel")).toHaveTextContent("оценка 9,0+ · до 1 км");
  });
});

/* ================================================================ review 6.3: rollout */

describe("review 6.3: rollout — older BFF / offers / preferences", () => {
  it("BFF says offers did not take the hotel conditions (HOTEL_PREFS_PENDING) — said, not silent", async () => {
    const set = abu63();
    set.notes = [...set.notes, "HOTEL_PREFS_PENDING"];
    renderTrip({ get: vi.fn(async () => set) }, { prof: profile(HP({ rating_min: 9, max_distance_km: 1 })) });
    await screen.findByTestId("trip-pass");
    expect(screen.getByTestId("trip-notes")).toHaveTextContent("Условия отеля применятся чуть позже — этот расчёт без них.");
  });

  it("an older BFF rejects the trip's hotel_filters → the same calculation without them and the same note", async () => {
    const get = vi.fn(async () => abu63());
    const recalculate = vi.fn(async () => {
      throw new ApiError(422, "VALIDATION_ERROR", "bad", { field: "hotel_filters" });
    });
    renderTrip({ get, recalculate: recalculate as unknown as Api["offers"]["recalculate"] });
    await screen.findByTestId("trip-pass");
    fireEvent.click(screen.getByTestId("trip-settings-toggle"));
    fireEvent.click(within(screen.getByTestId("trip-hotel-set")).getByRole("radio", { name: "15 км" }));
    await waitFor(() => expect(recalculate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    expect(screen.queryByTestId("trip-recalc-error")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("trip-notes")).toHaveTextContent("Условия отеля применятся чуть позже"));
  });

  it("profile: hotel_prefs rejected as an unknown field (older BFF / preferences) → «станут доступны через пару минут», no error", async () => {
    const prefs = { ...F.filledPreferences(), hotel_prefs: HP() };
    const patch = vi.fn(async () => {
      throw new ApiError(422, "PREFERENCES_INVALID", "bad", { field: "hotel_prefs" });
    });
    const onClose = vi.fn();
    const prof = { ...profile(), preferences: prefs } as Profile;
    const api = { profile: { preferences: patch }, directory: { interests: async () => ({ items: [] }), geographies: async () => ({ items: [] }) } } as unknown as Api;
    const ctx = { api, profile: prof, setProfile: vi.fn(), reloadProfile: vi.fn(async () => prof), config: CONFIG } as unknown as AppCtx;
    render(
      <I18nProvider initial="ru">
        <AppContext.Provider value={ctx}>
          <PrefEditor kind="hotel" onClose={onClose} />
          <ToastHost />
        </AppContext.Provider>
      </I18nProvider>,
    );
    fireEvent.click(within(screen.getByTestId("editor-hotel")).getByRole("button", { name: "9,0" }));
    await act(async () => mainButtonStore.top()!.onClick());
    expect(patch).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Настройки отеля станут доступны через пару минут");
  });
});

// keep the OfferSetView import used (type of the fixture sets)
export type _Set = OfferSetView;

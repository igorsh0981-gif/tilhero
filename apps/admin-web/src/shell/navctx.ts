import { createContext, useContext } from "react";
import type { Route } from "../state/route";

export interface Nav {
  route: Route;
  navigate(page: string, id?: string | null): void;
}
export const NavCtx = createContext<Nav>({ route: { page: "", id: null }, navigate: () => undefined });
export const useNav = () => useContext(NavCtx);

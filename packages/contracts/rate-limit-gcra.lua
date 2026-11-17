-- TilHero: единый лимитер запросов (спринт 9, INTERNAL_API §2.1) — GCRA на одном ключе субъекта.
-- Эталон; копии — py-common tilhero_common/ratelimit.py (GCRA_LUA) и ts-common src/rateLimit.ts (GCRA_LUA),
-- тесты обеих сторон сверяют копию с этим файлом и прогоняют packages/contracts/rate-limit-vectors.json.
-- KEYS[1] rl:<policy>:<subject>   — TAT (theoretical arrival time), мкс
-- KEYS[2] rlm:<policy>:<minute>   — метрики минуты {allowed, rejected}
-- KEYS[3] rlt:<policy>:<minute>   — ZSET отказов по субъекту (псевдоним), ≤ ARGV[6]
-- ARGV[1] интервал между запросами, мкс (window_s * 1e6 / limit, целое)
-- ARGV[2] burst (≥ 1)
-- ARGV[3] now, мкс ("" — время Redis: реплики делят одни часы)
-- ARGV[4] субъект для топа отказов
-- ARGV[5] TTL метрик, с
-- ARGV[6] размер топа отказов
-- → {allowed 0|1, retry_after_ms, remaining}
local t = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
if not now then
  local tm = redis.call('TIME')
  now = tonumber(tm[1]) * 1000000 + tonumber(tm[2])
end
local tat = tonumber(redis.call('GET', KEYS[1]))
if not tat or tat < now then
  tat = now
end
local new_tat = tat + t
local allow_at = new_tat - burst * t
local ttl = tonumber(ARGV[5])
if now < allow_at then
  redis.call('HINCRBY', KEYS[2], 'rejected', 1)
  redis.call('EXPIRE', KEYS[2], ttl)
  local top = tonumber(ARGV[6])
  redis.call('ZINCRBY', KEYS[3], 1, ARGV[4])
  if redis.call('ZCARD', KEYS[3]) > top then
    redis.call('ZREMRANGEBYRANK', KEYS[3], 0, -(top + 1))
  end
  redis.call('EXPIRE', KEYS[3], ttl)
  return {0, math.ceil((allow_at - now) / 1000), 0}
end
redis.call('SET', KEYS[1], string.format('%d', new_tat), 'PX', math.ceil((new_tat - now) / 1000))
redis.call('HINCRBY', KEYS[2], 'allowed', 1)
redis.call('EXPIRE', KEYS[2], ttl)
return {1, 0, math.floor((now - allow_at) / t)}

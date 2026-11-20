-- TilHero: подготовка PostgreSQL (stage/prod на Railway, локальный e2e-стенд) — две роли и схема на сервис.
-- Спринт 1: identity_consent, learning_plan, social, support, notifications, audit, experience_config;
-- спринт 2: admin_identity, user_admin; спринт 3: catalog, diagnostics; спринт 4: lessons, assessment, ai_gateway;
-- спринт 5: memory; спринт 6: gamification.
-- Новые сервисы учебного контура добавляются в массив ниже.
-- Запуск (идемпотентно, под суперпользователем/владельцем БД):
--   psql "$DATABASE_PUBLIC_URL" -v ON_ERROR_STOP=1 -f infra/db/bootstrap.sql
--
-- Модель прав (ревью спринта 1, P4/P7):
--   <svc>_owner — владелец схемы и всех таблиц; под ним идут ТОЛЬКО миграции (MIGRATION_DATABASE_URL, Railway preDeploy);
--   <svc>       — роль сервиса в рантайме (DATABASE_URL): USAGE на схему + DML на таблицы, без DDL. Не будучи
--                 владельцем, сервис не может снять триггеры неизменяемости (audit_records, consents, config_versions),
--                 изменить структуру или удалить таблицы; TRUNCATE не выдаётся никому, кроме владельца.
--   audit       — дополнительно: на audit_records только SELECT и INSERT (UPDATE/DELETE отзываются здесь и миграцией
--                 audit 0002), на outbox/inbox — DML.
-- Пароли ролей задайте после запуска: ALTER ROLE <роль> PASSWORD '<сгенерированный>'; роли создаются без пароля.
-- Существующая установка (схема и таблицы принадлежат роли сервиса) переводится на эту модель: владение
-- переназначается на <svc>_owner (REASSIGN OWNED), роли сервиса выдаются права на существующие объекты.
-- Зеркало для тестов: tilhero_common.testing.grants_sql / create_service_roles.
SET client_min_messages TO WARNING;
DO $$
DECLARE
  svc text;
  owner text;
BEGIN
  FOREACH svc IN ARRAY ARRAY['identity_consent','learning_plan','social','support','notifications','audit',
                                  'experience_config','admin_identity','user_admin','catalog','diagnostics',
                                  'lessons','assessment','ai_gateway','memory',
                                  'gamification']
  LOOP
    owner := svc || '_owner';
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = svc) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD NULL', svc);
    END IF;
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = owner) THEN
      EXECUTE format('CREATE ROLE %I LOGIN PASSWORD NULL', owner);
    END IF;
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', svc, owner);
    -- прежняя модель «сервис = владелец»: всё, чем владеет роль сервиса, переходит владельцу миграций
    EXECUTE format('REASSIGN OWNED BY %I TO %I', svc, owner);
    EXECUTE format('ALTER SCHEMA %I OWNER TO %I', svc, owner);
    EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I, %I', svc, owner);
    EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', svc, svc);
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', svc, svc);
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I, %I', current_database(), svc, owner);
    EXECUTE format('ALTER ROLE %I SET search_path = %I', svc, svc);
    EXECUTE format('ALTER ROLE %I SET search_path = %I', owner, svc);
    -- таблицы, которые создаст владелец (миграции): DML для роли сервиса
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                   'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner, svc, svc);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I '
                   'GRANT USAGE, SELECT ON SEQUENCES TO %I', owner, svc, svc);
    -- уже существующие объекты
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', svc, svc);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', svc, svc);
    EXECUTE format('REVOKE TRUNCATE ON ALL TABLES IN SCHEMA %I FROM %I', svc, svc);
  END LOOP;
  -- журнал аудита: append-only на уровне прав (после «GRANT … ON ALL TABLES» выше — снова отзываем)
  IF to_regclass('audit.audit_records') IS NOT NULL THEN
    REVOKE UPDATE, DELETE, TRUNCATE ON audit.audit_records FROM audit;
  END IF;
END $$;
-- Затем: ALTER ROLE identity_consent PASSWORD '…'; ALTER ROLE identity_consent_owner PASSWORD '…'; и т.д.
-- Railway: DATABASE_URL сервиса — роль <svc>; MIGRATION_DATABASE_URL (только для preDeploy) — роль <svc>_owner.

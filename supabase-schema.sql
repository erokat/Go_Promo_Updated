-- SQL-скрипт инициализации и enterprise-оптимизации для Supabase
-- Настройки Схемы, Сверхнадежный Row Level Security (RLS), Высокопроизводительные Индексы и Хранимые Процедуры (RPC)

-- =========================================================================
-- 1. СТРУКТУРА ТАБЛИЦ И СХЕМА ДАННЫХ
-- =========================================================================

-- Таблицы настроек и призов (Восстановлены для синхронизации и валидации безопасности)
CREATE TABLE IF NOT EXISTS public.settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.prizes (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    link TEXT
);

-- Таблица участников (Participants)
CREATE TABLE IF NOT EXISTS public.participants (
    receipt TEXT PRIMARY KEY, -- Код чека (ФД), длина 12 знаков
    check_time TIMESTAMPTZ NOT NULL, -- Время формирования чека
    amount NUMERIC NOT NULL CHECK (amount >= 0),
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    won BOOLEAN NOT NULL DEFAULT false,
    date TIMESTAMPTZ NOT NULL DEFAULT now() -- Дата регистрации в системе
);

-- Таблица победителей (Winners)
CREATE TABLE IF NOT EXISTS public.winners (
    receipt TEXT PRIMARY KEY REFERENCES public.participants(receipt) ON DELETE CASCADE,
    name TEXT NOT NULL,
    phone TEXT NOT NULL,
    prize INTEGER NOT NULL, -- Номер по списку призов (1-10)
    prize_name TEXT NOT NULL, -- Кэшированное название приза на момент розыгрыша
    date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Таблица логов действий администратора (Logs)
CREATE TABLE IF NOT EXISTS public.logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action TEXT NOT NULL,
    receipt TEXT,
    admin_user TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Профили администраторов (для маппинга авторизованных аккаунтов)
CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    username TEXT UNIQUE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =========================================================================
-- 2. ВЫСОКОПРОИЗВОДИТЕЛЬНЫЕ ИНДЕКСЫ ДЛЯ НАГРУЗКИ 20 000 - 30 000 УЧАСТНИКОВ
-- =========================================================================

-- Оптимизация поиска по фону и дате регистрации
CREATE INDEX IF NOT EXISTS idx_participants_phone ON public.participants(phone);
CREATE INDEX IF NOT EXISTS idx_participants_date_desc ON public.participants(date DESC);

-- Частичный индекс для мгновенного Index-Only Scan при проверке неразыгранных записей
CREATE INDEX IF NOT EXISTS idx_participants_eligible ON public.participants(receipt) WHERE won = false;

-- Высокопроизводительный функциональный индекс для мгновенного розыгрыша O(log N) на основе криптографического хэша
CREATE INDEX IF NOT EXISTS idx_participants_md5 ON public.participants (md5(receipt)) WHERE won = false;

-- Составной индекс для листинга и фильтрации победителей
CREATE INDEX IF NOT EXISTS idx_participants_won_date_desc ON public.participants(won, date DESC);

-- Индексы для таблицы победителей
CREATE INDEX IF NOT EXISTS idx_winners_prize ON public.winners(prize);
CREATE INDEX IF NOT EXISTS idx_winners_date_desc ON public.winners(date DESC);

-- Оптимизация аудита логов: сортировка по времени, фильтрация по админу и действию
CREATE INDEX IF NOT EXISTS idx_logs_created_at_desc ON public.logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_logs_admin_action ON public.logs(admin_user, action);


-- =========================================================================
-- 3. АБСОЛЮТНАЯ БЕЗОПАСНОСТЬ: Row Level Security (RLS) ПОЛНЫЙ АУДИТ
-- =========================================================================

-- Функция проверки прав администратора (Security Definer для обхода рекурсии RLS)
CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.admin_users
        WHERE id = auth.uid()
    );
$$;

-- Принудительное включение RLS для всех таблиц
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prizes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.winners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;

-- Удаление старых политик (предотвращение конфликтов миграции)
DROP POLICY IF EXISTS "Allow public select settings" ON public.settings;
DROP POLICY IF EXISTS "Allow admin all settings" ON public.settings;
DROP POLICY IF EXISTS "Allow public select prizes" ON public.prizes;
DROP POLICY IF EXISTS "Allow admin all prizes" ON public.prizes;
DROP POLICY IF EXISTS "Allow public insert participants" ON public.participants;
DROP POLICY IF EXISTS "Allow admin all participants" ON public.participants;
DROP POLICY IF EXISTS "Allow select winners if published" ON public.winners;
DROP POLICY IF EXISTS "Allow public select winners if published" ON public.winners;
DROP POLICY IF EXISTS "Allow public select winners" ON public.winners;
DROP POLICY IF EXISTS "Allow admin all winners" ON public.winners;
DROP POLICY IF EXISTS "Allow admin all logs" ON public.logs;
DROP POLICY IF EXISTS "Allow admin all admin_users" ON public.admin_users;
DROP POLICY IF EXISTS "Allow admin self admin_users" ON public.admin_users;
DROP POLICY IF EXISTS "Allow public select admin_users" ON public.admin_users;
DROP POLICY IF EXISTS "Allow admin select admin_users" ON public.admin_users;

-- СВЕРХБЕЗОПАСНЫЙ СБОР ПОЛИТИК RLS (Идемпотентный, чистый от рекурсий)

-- 0. Настройки и Призы (Settings & Prizes): Чтение всем, запись админам
DROP POLICY IF EXISTS "Allow public select settings" ON public.settings;
CREATE POLICY "Allow public select settings" ON public.settings FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow admin all settings" ON public.settings;
CREATE POLICY "Allow admin all settings" ON public.settings FOR ALL TO authenticated USING (
    public.is_admin()
);

DROP POLICY IF EXISTS "Allow public select prizes" ON public.prizes;
CREATE POLICY "Allow public select prizes" ON public.prizes FOR SELECT TO public USING (true);

DROP POLICY IF EXISTS "Allow admin all prizes" ON public.prizes;
CREATE POLICY "Allow admin all prizes" ON public.prizes FOR ALL TO authenticated USING (
    public.is_admin()
);

-- А. Участники (Participants): Публике разрешен РЕГИСТРАЦИОННЫЙ INSERT. Любой SELECT/UPDATE/DELETE полностью закрыт!
DROP POLICY IF EXISTS "Allow public insert participants" ON public.participants;
CREATE POLICY "Allow public insert participants" ON public.participants
    FOR INSERT TO public WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin all participants" ON public.participants;
CREATE POLICY "Allow admin all participants" ON public.participants
    FOR ALL TO authenticated USING (
        public.is_admin()
    ) WITH CHECK (
        public.is_admin()
    );

-- Б. Победители (Winners): Чтение разрешено всем публичным пользователям. Модификации — только администраторам.
DROP POLICY IF EXISTS "Allow public select winners" ON public.winners;
CREATE POLICY "Allow public select winners" ON public.winners
    FOR SELECT TO public USING (
        EXISTS (SELECT 1 FROM public.settings WHERE key = 'winnersPublished' AND value = 'true')
    );

DROP POLICY IF EXISTS "Allow admin all winners" ON public.winners;
CREATE POLICY "Allow admin all winners" ON public.winners
    FOR ALL TO authenticated USING (
        public.is_admin()
    ) WITH CHECK (
        public.is_admin()
    );

-- В. Логи (Logs): Только подтвержденные администраторы имеют доступ. Публичный доступ закрыт полностью.
DROP POLICY IF EXISTS "Allow admin all logs" ON public.logs;
CREATE POLICY "Allow admin all logs" ON public.logs
    FOR ALL TO authenticated USING (
        public.is_admin()
    ) WITH CHECK (
        public.is_admin()
    );

-- Г. Администраторы (Admin Users):
-- Чтение разрешено вошедшему пользователю для сверки своего статуса.
-- Полностью устранена рекурсивная проверка для предотвращения бесконечного зацикливания.
-- Модификация (INSERT/UPDATE/DELETE) закрыта для ЛЮБЫХ клиентских API ролей (никакой Privilege Escalation!).
-- Новые администраторы могут добавляться только через системный терминал или RPC инициализации.
DROP POLICY IF EXISTS "Allow admin select admin_users" ON public.admin_users;
CREATE POLICY "Allow admin select admin_users" ON public.admin_users
    FOR SELECT TO authenticated USING (
        id = auth.uid()
    );


-- =========================================================================
-- 4. ВАЛИДАЦИЯ ДАННЫХ И ТРИГГЕРЫ
-- =========================================================================

-- Функция валидации регистрации участника (настройки перенесены внутрь кода функции в виде констант)
CREATE OR REPLACE FUNCTION public.validate_participant_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    reg_enabled TEXT;
    start_date TIMESTAMPTZ;
    end_date TIMESTAMPTZ;
    min_amount NUMERIC;
BEGIN
    -- Получаем актуальные настройки из базы данных
    SELECT value INTO reg_enabled FROM public.settings WHERE key = 'registrationEnabled';
    SELECT value::timestamptz INTO start_date FROM public.settings WHERE key = 'startDate';
    SELECT value::timestamptz INTO end_date FROM public.settings WHERE key = 'endDate';
    SELECT value::numeric INTO min_amount FROM public.settings WHERE key = 'minPurchaseAmount';
    
    -- Защита от подделки статуса и времени (Security Fix)
    NEW.won := false;
    NEW.date := now();

    -- 1. Проверка доступности ручной регистрации
    IF reg_enabled IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'Регистрация временно приостановлена администратором';
    END IF;

    -- 2. Проверка временных рамок
    IF start_date IS NOT NULL AND now() < start_date THEN
        RAISE EXCEPTION 'Регистрация чеков еще не началась';
    END IF;

    IF end_date IS NOT NULL AND now() > end_date THEN
        RAISE EXCEPTION 'Регистрация чеков завершена';
    END IF;

    -- 3. Проверка суммы
    IF NEW.amount < min_amount THEN
        RAISE EXCEPTION 'Минимальная сумма покупки для участия в акции — % рублей', min_amount;
    END IF;

    -- 4. Проверка фискального кода (12 цифр, начинается на 000081)
    IF length(NEW.receipt) <> 12 OR NEW.receipt !~ '^\d{12}$' THEN
        RAISE EXCEPTION 'Неправильный код чека. Код должен состоять из 12 цифр';
    END IF;
    
    IF NOT NEW.receipt LIKE '000081%' THEN
        RAISE EXCEPTION 'Неправильный код чека. Код должен начинаться на 000081';
    END IF;

    -- 5. Проверка телефонного номера (8 цифр)
    IF NEW.phone !~ '^\d{8}$' THEN
        RAISE EXCEPTION 'Некорректный номер телефона (должен состоять ровно из 8 цифр)';
    END IF;

    -- 6. Проверка чека на дубликат (уже зарегистрирован)
    IF EXISTS (SELECT 1 FROM public.participants WHERE receipt = NEW.receipt) THEN
        RAISE EXCEPTION 'Такой номер чека уже зарегистрирован';
    END IF;

    RETURN NEW;
END;
$$;

-- Навешивание валидации перед INSERT
DROP TRIGGER IF EXISTS validate_participant_trigger ON public.participants;
CREATE TRIGGER validate_participant_trigger
BEFORE INSERT ON public.participants
FOR EACH ROW
EXECUTE FUNCTION public.validate_participant_registration();

-- Полностью удаляем триггер автоматического добавления админов при регистрации в Auth
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP FUNCTION IF EXISTS public.handle_new_auth_user();

-- Автоматическое управление won = false у участника при удалении из winners (Исключение рассинхронизации)
CREATE OR REPLACE FUNCTION public.handle_winner_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE public.participants
    SET won = false
    WHERE receipt = OLD.receipt;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS on_winner_deleted ON public.winners;
CREATE TRIGGER on_winner_deleted
AFTER DELETE ON public.winners
FOR EACH ROW
EXECUTE FUNCTION public.handle_winner_deletion();


-- =========================================================================
-- 5. ВЫСОКОПРОИЗВОДИТЕЛЬНАЯ ТРАНЗАКЦИОННАЯ СЛУЖБА РОЗЫГРЫША (RPC)
-- =========================================================================

DROP FUNCTION IF EXISTS public.draw_winner();
DROP FUNCTION IF EXISTS public.draw_winner(text);

CREATE OR REPLACE FUNCTION public.draw_winner(admin_email TEXT DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    winner_record RECORD;
    prize_idx INT := NULL;
    drawn_prize_name TEXT;
    total_prizes INT := 10; -- Ровно 10 призов
    used_prizes INT[];
    total_eligible INT;
    random_hash TEXT;
BEGIN
    -- 1. Строгая проверка прав: допускается только service_role или верифицированный администратор
    IF auth.role() <> 'service_role' AND NOT EXISTS (
        SELECT 1 FROM public.admin_users WHERE id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Недостаточно прав для проведения розыгрыша';
    END IF;

    -- 2. ЭКСКЛЮЗИВНАЯ БЛОКИРОВКА таблицы winners для 100% защиты от Race Conditions и двойного выбора призов
    LOCK TABLE public.winners IN EXCLUSIVE MODE;

    -- 3. Получение списка уже зарегистрированных призовых мест
    SELECT COALESCE(array_agg(prize), '{}'::integer[]) INTO used_prizes FROM public.winners;

    -- 4. Поиск первого доступного свободного приза по направления убывания (10 -> 1)
    FOR i IN REVERSE total_prizes..1 LOOP
        IF NOT (i = ANY(used_prizes)) THEN
            prize_idx := i;
            EXIT;
        END IF;
    END LOOP;

    -- Если все призы уже заняты
    IF prize_idx IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'message', 'Все главные призы (' || total_prizes || ' мест) уже разыграны!'
        );
    END IF;

    -- 5. Получение наименования приза по его индексу
    SELECT name INTO drawn_prize_name FROM public.prizes WHERE id = prize_idx;
    IF drawn_prize_name IS NULL THEN
        drawn_prize_name := 'Приз №' || prize_idx;
    END IF;

    -- 6. СВЕРХВЫСОКОПРОИЗВОДИТЕЛЬНЫЙ ОТБОР СЛУЧАЙНОГО УЧАСТНИКА
    -- Безопасный и быстрый подсчет доступных участников по индексу
    SELECT COUNT(*) INTO total_eligible FROM public.participants WHERE won = false;

    -- Если нет участников для розыгрыша
    IF total_eligible = 0 THEN
        RETURN json_build_object(
            'success', false,
            'message', 'Нет доступных участников для розыгрыша'
        );
    END IF;

    -- Шаг 6.1. Генерируем случайную точку (хэш) в 128-битном шестнадцатеричном пространстве MD5
    random_hash := md5(random()::text);

    -- Шаг 6.2. Ищем первого участника, чей md5(receipt) больше или равен случайному хэшу
    SELECT * INTO winner_record
    FROM public.participants
    WHERE won = false AND md5(receipt) >= random_hash
    ORDER BY md5(receipt) ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;

    -- Шаг 6.3. Заворачивание границы (Wrap-around)
    IF winner_record IS NULL THEN
        SELECT * INTO winner_record
        FROM public.participants
        WHERE won = false
        ORDER BY md5(receipt) ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED;
    END IF;

    -- Шаг 6.4. Блокирующий резервный захват
    IF winner_record IS NULL THEN
        SELECT * INTO winner_record
        FROM public.participants
        WHERE won = false
        LIMIT 1
        FOR UPDATE SKIP LOCKED;
    END IF;

    -- Если участников так и не обнаружено
    IF winner_record IS NULL THEN
        RETURN json_build_object(
            'success', false,
            'message', 'Не удалось захватить запись участника. Пожалуйста, повторите розыгрыш'
        );
    END IF;

    -- 7. АТОМАРНАЯ ТРАНЗАКЦИОННАЯ МОДИФИКАЦИЯ СТАТУСОВ УЧАСТНИКОВ И ТАБЛИЦЫ ПОВЕДИТЕЛЕЙ
    UPDATE public.participants
    SET won = true
    WHERE receipt = winner_record.receipt;

    INSERT INTO public.winners (receipt, name, phone, prize, prize_name, date)
    VALUES (
        winner_record.receipt,
        winner_record.name,
        winner_record.phone,
        prize_idx,
        drawn_prize_name,
        now()
    );

    -- 8. Системное логирование действия администратора
    INSERT INTO public.logs (action, receipt, admin_user, created_at)
    VALUES (
        'DRAW_WINNER',
        winner_record.receipt,
        COALESCE(admin_email, auth.jwt()->>'email', 'service_role/admin'),
        now()
    );

    -- Возврат успешного результата
    RETURN json_build_object(
        'success', true,
        'winner', json_build_object(
            'receipt', winner_record.receipt,
            'name', winner_record.name,
            'phone', winner_record.phone,
            'prize', prize_idx,
            'prizeName', drawn_prize_name
        )
    );
END;
$$;


-- =========================================================================
-- 6. СИСТЕМА ОЧИСТКИ ЛОГОВ (Housekeeping) ДЛЯ СТАБИЛЬНОЙ РАБОТЫ
-- =========================================================================

CREATE OR REPLACE FUNCTION public.clean_old_logs(days_to_keep INT DEFAULT 90)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    deleted_count INT;
BEGIN
    -- Настройки удаления логов: только service_role или администратор
    IF auth.role() <> 'service_role' AND NOT EXISTS (
        SELECT 1 FROM public.admin_users WHERE id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Недостаточно прав для очистки логов';
    END IF;

    DELETE FROM public.logs
    WHERE created_at < now() - (days_to_keep || ' days')::interval;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;


-- =========================================================================
-- 7. ПОДДЕРЖКА ПЕРВИЧНОЙ ИНИЦИАЛИЗАЦИИ БАЗЫ ДАННЫХ И АДМИНИСТРАТОРОВ
-- =========================================================================

-- RPC для быстрого и безопасного подсчета количества администраторов в системе
CREATE OR REPLACE FUNCTION public.get_admin_count()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cnt integer;
BEGIN
    SELECT COUNT(*) INTO cnt FROM public.admin_users;
    RETURN cnt;
END;
$$;

-- RPC для добавления первого администратора в систему, когда в таблице 0 записей
CREATE OR REPLACE FUNCTION public.initialize_first_admin(admin_username TEXT)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cnt integer;
    new_uid uuid;
BEGIN
    -- Получаем ID текущего аутентифицированного пользователя
    new_uid := auth.uid();
    IF new_uid IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'Пожалуйста, войдите в систему.');
    END IF;

    -- Подсчитываем текущее число администраторов
    SELECT COUNT(*) INTO cnt FROM public.admin_users;
    
    -- Блокируем вызов, если администраторы уже есть (предотвращение Privilege Escalation)
    IF cnt > 0 THEN
        RETURN json_build_object('success', false, 'message', 'Регистрация первого администратора заблокирована: администратор уже настроен.');
    END IF;

    -- Добавляем первого администратора
    INSERT INTO public.admin_users (id, username)
    VALUES (new_uid, admin_username);

    RETURN json_build_object('success', true, 'message', 'Первый администратор успешно зарегистрирован.');
END;
$$;


-- =========================================================================
-- 8. ТРАНЗАКЦИОННОЕ УДАЛЕНИЕ ПРИЗА И ПЕРЕНУМЕРАЦИЯ (Security & Race Condition Fix)
-- =========================================================================

CREATE OR REPLACE FUNCTION public.delete_prize_and_reorder(prize_idx_to_delete INT, admin_email TEXT DEFAULT NULL)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    winner_receipt TEXT;
    r RECORD;
    new_name TEXT;
BEGIN
    -- 1. Проверяем роль администратора
    IF auth.role() <> 'service_role' AND NOT EXISTS (
        SELECT 1 FROM public.admin_users WHERE id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Недостаточно прав для удаления приза';
    END IF;

    -- Эксклюзивные блокировки для предотвращения race conditions
    LOCK TABLE public.winners IN EXCLUSIVE MODE;
    LOCK TABLE public.prizes IN EXCLUSIVE MODE;

    -- 2. Находим победителя, связанного с удаляемым призом (если есть)
    SELECT receipt INTO winner_receipt FROM public.winners WHERE prize = prize_idx_to_delete;

    -- 3. Если победитель найден, удаляем его из winners. Наш триггер on_winner_deleted автоматически сделает won = false у участника
    IF winner_receipt IS NOT NULL THEN
        DELETE FROM public.winners WHERE receipt = winner_receipt;
    END IF;

    -- 4. Удаляем сам приз
    DELETE FROM public.prizes WHERE id = prize_idx_to_delete;

    -- 5. Сдвигаем все призы id > prize_idx_to_delete на 1 вверх (id - 1)
    UPDATE public.prizes
    SET id = id - 1
    WHERE id > prize_idx_to_delete;

    -- 6. Перенумеровываем победителей в winners таблице
    -- Сдвигаем prize на 1 вверх (prize - 1) для всех prize > prize_idx_to_delete.
    UPDATE public.winners
    SET prize = prize - 1
    WHERE prize > prize_idx_to_delete;

    -- Теперь обновим prize_name для измененных победителей на основе новой структуры призов
    FOR r IN SELECT receipt, prize FROM public.winners WHERE prize >= prize_idx_to_delete LOOP
        SELECT name INTO new_name FROM public.prizes WHERE id = r.prize;
        IF new_name IS NULL THEN
            new_name := 'Приз №' || r.prize;
        END IF;
        
        UPDATE public.winners
        SET prize_name = new_name
        WHERE receipt = r.receipt;
    END LOOP;

    -- Записываем лог
    INSERT INTO public.logs (action, admin_user, created_at)
    VALUES (
        'DELETE_PRIZE',
        COALESCE(admin_email, auth.jwt()->>'email', 'service_role/admin'),
        now()
    );

    RETURN json_build_object(
        'success', true,
        'message', 'Приз успешно удален, победители перенумерованы и сбалансированы.'
    );
END;
$$;


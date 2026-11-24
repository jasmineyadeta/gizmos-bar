-- Gizmos Bar schema. Safe to run repeatedly.

create table if not exists public.owners (
  user_id uuid primary key references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  bar_name text not null default 'Gizmo''s Bar',
  timezone text not null default 'America/New_York',
  mode text not null default 'auto' check (mode in ('auto', 'open', 'closed')),
  schedule jsonb not null default '{
    "0": {"on": true,  "open": "14:00", "close": "22:00"},
    "1": {"on": false, "open": "17:00", "close": "22:00"},
    "2": {"on": false, "open": "17:00", "close": "22:00"},
    "3": {"on": false, "open": "17:00", "close": "22:00"},
    "4": {"on": false, "open": "17:00", "close": "22:00"},
    "5": {"on": true,  "open": "17:00", "close": "23:30"},
    "6": {"on": true,  "open": "14:00", "close": "23:30"}
  }'::jsonb,
  closed_message text not null default 'The bar is closed right now. Come back soon!',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

create table if not exists public.app_config (
  key text primary key,
  value text not null
);

create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  description text not null default '' check (char_length(description) <= 300),
  category text not null default 'Cocktails' check (char_length(category) between 1 and 40),
  available boolean not null default true,
  stock int check (stock is null or stock >= 0),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  guest_name text not null check (char_length(guest_name) between 1 and 40),
  item_id uuid references public.menu_items on delete set null,
  item_name text not null,
  notes text not null default '' check (char_length(notes) <= 200),
  status text not null default 'new' check (status in ('new', 'done')),
  created_at timestamptz not null default now()
);
create index if not exists orders_created_idx on public.orders (created_at desc);

create table if not exists public.push_subscriptions (
  endpoint text primary key,
  subscription jsonb not null,
  user_id uuid references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

-- Helpers ------------------------------------------------------------------

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners where user_id = auth.uid());
$$;

create or replace function public.owner_exists() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.owners);
$$;

-- The first signed-in account to call this becomes the bar owner.
create or replace function public.claim_owner() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  lock table public.owners in exclusive mode;
  if not exists (select 1 from public.owners) then
    insert into public.owners (user_id) values (auth.uid());
  end if;
  return public.is_owner();
end $$;

create or replace function public.bar_is_open() returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  s public.settings;
  local_ts timestamp;
  dow int;
  t time;
  today jsonb;
  yday jsonb;
begin
  select * into s from public.settings where id = 1;
  if s.mode = 'open' then return true; end if;
  if s.mode = 'closed' then return false; end if;
  local_ts := now() at time zone s.timezone;
  dow := extract(dow from local_ts)::int;
  t := local_ts::time;
  today := s.schedule -> dow::text;
  yday := s.schedule -> ((dow + 6) % 7)::text;
  -- Today's window (may run past midnight).
  if coalesce((today ->> 'on')::boolean, false) then
    if (today ->> 'open')::time <= (today ->> 'close')::time then
      if t >= (today ->> 'open')::time and t < (today ->> 'close')::time then return true; end if;
    else
      if t >= (today ->> 'open')::time then return true; end if;
    end if;
  end if;
  -- Yesterday's window spilling past midnight.
  if coalesce((yday ->> 'on')::boolean, false)
     and (yday ->> 'open')::time > (yday ->> 'close')::time
     and t < (yday ->> 'close')::time then
    return true;
  end if;
  return false;
end $$;

-- Called only by the edge function (service role).
create or replace function public.place_order(p_name text, p_item uuid, p_notes text)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  item public.menu_items;
  o public.orders;
begin
  if not public.bar_is_open() then raise exception 'BAR_CLOSED'; end if;
  select * into item from public.menu_items where id = p_item for update;
  if not found then raise exception 'NO_SUCH_DRINK'; end if;
  if not item.available or item.stock = 0 then raise exception 'SOLD_OUT'; end if;
  if item.stock is not null then
    update public.menu_items
      set stock = stock - 1, available = (stock - 1) > 0
      where id = item.id;
  end if;
  insert into public.orders (guest_name, item_id, item_name, notes)
    values (left(trim(p_name), 40), item.id, item.name, left(coalesce(trim(p_notes), ''), 200))
    returning * into o;
  return o;
end $$;
revoke execute on function public.place_order(text, uuid, text) from public, anon, authenticated;

-- Lets a guest check whether their drink is ready, without exposing other orders.
create or replace function public.order_status(p_id uuid) returns text
language sql stable security definer set search_path = public as $$
  select status from public.orders where id = p_id;
$$;

-- Row level security ---------------------------------------------------------

alter table public.owners enable row level security;
alter table public.settings enable row level security;
alter table public.app_config enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.push_subscriptions enable row level security;

drop policy if exists "owners read self" on public.owners;
create policy "owners read self" on public.owners for select using (user_id = auth.uid());

drop policy if exists "settings read" on public.settings;
create policy "settings read" on public.settings for select using (true);
drop policy if exists "settings write" on public.settings;
create policy "settings write" on public.settings for update using (public.is_owner()) with check (public.is_owner());

drop policy if exists "config read" on public.app_config;
create policy "config read" on public.app_config for select using (true);

drop policy if exists "menu read" on public.menu_items;
create policy "menu read" on public.menu_items for select using (true);
drop policy if exists "menu write" on public.menu_items;
create policy "menu write" on public.menu_items for all using (public.is_owner()) with check (public.is_owner());

drop policy if exists "orders owner" on public.orders;
create policy "orders owner" on public.orders for all using (public.is_owner()) with check (public.is_owner());

drop policy if exists "push owner" on public.push_subscriptions;
create policy "push owner" on public.push_subscriptions for all
  using (public.is_owner()) with check (public.is_owner() and user_id = auth.uid());

-- Starter menu, only if empty.
insert into public.menu_items (name, description, category, sort)
select * from (values
  ('Old Fashioned', 'Bourbon, sugar, bitters, orange peel', 'Cocktails', 1),
  ('Margarita', 'Tequila, lime, triple sec, salted rim', 'Cocktails', 2),
  ('Gin & Tonic', 'Gin, tonic, lime', 'Cocktails', 3),
  ('Cold Beer', 'Ask Gizmo what''s in the fridge', 'Beer & Wine', 4),
  ('Glass of Wine', 'Red or white, say which in the note', 'Beer & Wine', 5),
  ('Shirley Temple', 'Ginger ale, grenadine, cherry', 'No Booze', 6)
) as v(name, description, category, sort)
where not exists (select 1 from public.menu_items);

-- Explicit grants (RLS above still decides which rows).
grant usage on schema public to anon, authenticated;
grant select on public.settings, public.app_config, public.menu_items to anon, authenticated;
grant update on public.settings to authenticated;
grant select, insert, update, delete on public.menu_items, public.orders, public.push_subscriptions to authenticated;
grant select on public.owners to authenticated;
grant execute on function public.owner_exists(), public.order_status(uuid), public.bar_is_open(), public.is_owner() to anon, authenticated;
grant execute on function public.claim_owner() to authenticated;

-- Family admin link -------------------------------------------------------
-- Anyone opening admin.html?k=<key> can manage the bar. Only the SHA-256 of the
-- key lives here (this repo is public). To change the link, replace the hash.
create table if not exists public.admin_key (
  id int primary key default 1 check (id = 1),
  key_hash text not null
);
alter table public.admin_key enable row level security;
revoke all on public.admin_key from anon, authenticated;
insert into public.admin_key (id, key_hash) values (1, '7837e3952d7a1369218c49b46d176a4bfef25af54d2e4b5d1f1d2a66d642c706')
  on conflict (id) do update set key_hash = excluded.key_hash;

create or replace function public.has_admin_key() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admin_key
    where key_hash = encode(sha256(convert_to(coalesce(
      nullif(current_setting('request.headers', true), '')::json ->> 'x-bar-key', ''), 'UTF8')), 'hex')
  );
$$;
grant execute on function public.has_admin_key() to anon, authenticated;

-- Owner = signed-in owner account OR anyone holding the family admin link.
create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_admin_key()
      or exists (select 1 from public.owners where user_id = auth.uid());
$$;

grant update on public.settings to anon;
grant select, insert, update, delete on public.menu_items, public.orders, public.push_subscriptions to anon;

drop policy if exists "push owner" on public.push_subscriptions;
create policy "push owner" on public.push_subscriptions for all
  using (public.is_owner()) with check (public.is_owner());

-- Gizmo's real menu (from his printed cocktail list) --------------------------
alter table public.menu_items add column if not exists image text;
-- tags are inferred by Claude (flavour/strength), not from Gizmo's list.
alter table public.menu_items add column if not exists tags jsonb not null default '[]'::jsonb;
create table if not exists public.seed_log (key text primary key, at timestamptz not null default now());
alter table public.seed_log enable row level security;
revoke all on public.seed_log from anon, authenticated;

do $$
begin
  if not exists (select 1 from public.seed_log where key = 'gizmo-menu-v1') then
    -- remove the placeholder starter drinks
    delete from public.menu_items where name in
      ('Old Fashioned','Margarita','Gin & Tonic','Cold Beer','Glass of Wine','Shirley Temple')
      and image is null;
    insert into public.menu_items (name, description, category, sort, image, tags) values
  ('Gin & Tonic / Bacardi & Coke etc.', '1 ounce spirit · 3 ounces mixer · slice of lemon', 'Highballs', 1, 'drinks/gin-tonic.jpg', '["fizzy", "light"]'::jsonb),
  ('Dry Martini', '2 ounces gin · 1/2 ounce dry vermouth · 1 dash angostura bitters · lemon twist', 'Gin', 2, 'drinks/dry-martini.jpg', '["strong", "dry", "stirred"]'::jsonb),
  ('Tom Collins', '2 ounces dry gin · 1 ounce lemon juice · 1/2 ounce simple syrup · Club soda, to top · lemon slice & maraschino cherry', 'Gin', 3, 'drinks/tom-collins.jpg', '["fizzy", "citrusy", "light"]'::jsonb),
  ('Martinez', '1 ounce gin · 1 ounce sweet vermouth · 3 dash augostura bitters · 1 teaspoon maraschino juice · lemon twist', 'Gin', 4, 'drinks/martinez.jpg', '["strong", "sweet", "stirred"]'::jsonb),
  ('Negroni', '1 ounce gin · 1 ounce campari · 1 ounce sweet vermouth · orange peel', 'Gin', 5, 'drinks/negroni.jpg', '["strong", "bitter", "stirred"]'::jsonb),
  ('French 75', '1 ounce gin · 1/2 ounce lemon juice · 1/2 ounce simple syrup · 3 ounces sparkling wine · lemon twist', 'Gin', 6, 'drinks/french-75.jpg', '["fizzy", "citrusy", "bubbly"]'::jsonb),
  ('Kir Royale', '1/2 ounce creme de cassis · sparkling wine, to top', 'Wine & Brandy', 7, 'drinks/kir-royale.jpg', '["fizzy", "fruity", "light", "bubbly"]'::jsonb),
  ('Cosmopolitan', '1 1/2 ounces vodka · 3/4 ounce triple sec · 3/4 ounce lime juice · 1/2 ounce cranberry juice · lime wedge', 'Vodka', 8, 'drinks/cosmopolitan.jpg', '["fruity", "citrusy"]'::jsonb),
  ('Moscow Mule', '2 ounces vodka · 1/2 ounce lime juice · 3 ounces ginger beer · lime slice', 'Vodka', 9, 'drinks/moscow-mule.jpg', '["fizzy", "spicy", "citrusy"]'::jsonb),
  ('Caesar', '2 ounces vodka · 4 ounces Clamato juice · Dash of Tabasco and/or Worcestershire sauce (to taste) · Garnish: lime or lemon slice · celery stalk/parsley sprig (optional)', 'Vodka', 10, 'drinks/caesar.jpg', '["savory", "spicy"]'::jsonb),
  ('Screwdriver', '1 1/2 ounces vodka · Orange juice', 'Vodka', 11, 'drinks/screwdriver.jpg', '["fruity", "light"]'::jsonb),
  ('Tequila Sunrise', '2 ounces tequila · 4 ounces orange juice · 1/4 ounce grenadine · orange slice and cherry', 'Tequila', 12, 'drinks/tequila-sunrise.jpg', '["fruity", "sweet"]'::jsonb),
  ('Margarita', '1 1/2 ounces tequila · 1/2 ounce triple sec · 1 ounce lime juice · lime slice · salt (optional)', 'Tequila', 13, 'drinks/margarita.jpg', '["citrusy", "tart"]'::jsonb),
  ('Mojito', '3 mint leaves · 1/2 ounce simple syrup · 2 ounces white rum · 3/4 ounce lime juice · Club soda, to top · mint sprig and lime slice', 'Rum', 14, 'drinks/mojito.jpg', '["fizzy", "minty", "citrusy"]'::jsonb),
  ('Hurricane', '1 ounce light rum · 1 ounce dark rum · 1 ounce navy-strength rum · 1/2 ounce simple syrup · 1/2 ounce passion fruit puree or pineapple juice · 1 ounce orange juice · 1 ounce lime juice · 1/2 teaspoon grenadine · orange slice and cherry', 'Rum', 15, 'drinks/hurricane.jpg', '["strong", "fruity", "sweet"]'::jsonb),
  ('Daiquiri', '2 ounces light rum · 1 ounce lime juice · 3/4 ounce demerara sugar syrup · lime twist', 'Rum', 16, 'drinks/daiquiri.jpg', '["citrusy", "tart"]'::jsonb),
  ('Manhattan', '2 ounces rye whiskey · 1 ounce sweet vermouth · 2 dashes angostura bitters · brandied cherry or lemon slice', 'Whisky', 17, 'drinks/manhattan.jpg', '["strong", "stirred"]'::jsonb),
  ('Old Fashioned', '1 teaspoon sugar · 3 dashes angostura bitters · 1 teaspoon water · 2 ounces bourbon or rye whiskey · orange twist', 'Whisky', 18, 'drinks/old-fashioned.jpg', '["strong", "stirred"]'::jsonb),
  ('Whisky Mac', '1 1/2 ounces blended scotch · 1 ounce Stone’s Original green ginger wine', 'Whisky', 19, 'drinks/whisky-mac.jpg', '["strong", "spicy", "warming"]'::jsonb),
  ('Brandy Sangaree', '1/2 teaspoon sugar · 1 teaspoon water · 2 ounces brandy · 1 ounce port wine · grated nutmeg', 'Wine & Brandy', 20, 'drinks/brandy-sangaree.jpg', '["strong", "warming", "sweet"]'::jsonb);
    insert into public.seed_log (key) values ('gizmo-menu-v1');
  end if;
end $$;

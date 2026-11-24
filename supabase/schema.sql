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
grant execute on function public.place_order(text, uuid, text) to service_role;

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

-- Ingredient stock ------------------------------------------------------------
-- Gizmo marks an ingredient out, and every drink that needs it stops being orderable.
-- Ingredient list and which drink needs what were worked out by Claude from his recipes
-- (garnishes and optional extras don't count as "needs").
create table if not exists public.ingredients (
  key text primary key,
  name text not null,
  grp text not null,
  in_stock boolean not null default true,
  sort int not null default 0
);
alter table public.ingredients enable row level security;
drop policy if exists "ingredients read" on public.ingredients;
create policy "ingredients read" on public.ingredients for select using (true);
drop policy if exists "ingredients write" on public.ingredients;
create policy "ingredients write" on public.ingredients for all using (public.is_owner()) with check (public.is_owner());
grant select on public.ingredients to anon, authenticated;
grant insert, update, delete on public.ingredients to anon, authenticated;

alter table public.menu_items add column if not exists needs text[] not null default '{}';
alter table public.menu_items drop constraint if exists menu_items_description_check;
alter table public.menu_items add constraint menu_items_description_check check (char_length(description) <= 500);
alter table public.menu_items drop constraint if exists menu_items_image_size;
alter table public.menu_items add constraint menu_items_image_size check (image is null or char_length(image) <= 400000);

insert into public.ingredients (key, name, grp, sort) values
  ('gin','Gin','Spirits',1), ('vodka','Vodka','Spirits',2), ('tequila','Tequila','Spirits',3),
  ('light_rum','Light / white rum','Spirits',4), ('dark_rum','Dark rum','Spirits',5), ('navy_rum','Navy-strength rum','Spirits',6),
  ('whiskey','Bourbon / rye whiskey','Spirits',7), ('scotch','Scotch','Spirits',8), ('brandy','Brandy','Spirits',9),
  ('dry_vermouth','Dry vermouth','Liqueurs & wine',10), ('sweet_vermouth','Sweet vermouth','Liqueurs & wine',11),
  ('campari','Campari','Liqueurs & wine',12), ('triple_sec','Triple sec','Liqueurs & wine',13),
  ('cassis','Crème de cassis','Liqueurs & wine',14), ('sparkling','Sparkling wine','Liqueurs & wine',15),
  ('port','Port','Liqueurs & wine',16), ('ginger_wine','Green ginger wine','Liqueurs & wine',17),
  ('mixers','Mixers (tonic, cola...)','Mixers & juice',18), ('soda','Club soda','Mixers & juice',19),
  ('ginger_beer','Ginger beer','Mixers & juice',20), ('orange_juice','Orange juice','Mixers & juice',21),
  ('cranberry','Cranberry juice','Mixers & juice',22), ('clamato','Clamato','Mixers & juice',23),
  ('passion_pineapple','Passion fruit or pineapple juice','Mixers & juice',24),
  ('lemons','Lemons / lemon juice','Fruit & garnish',25), ('limes','Limes / lime juice','Fruit & garnish',26),
  ('mint','Fresh mint','Fruit & garnish',27), ('cherries','Maraschino cherries','Fruit & garnish',28),
  ('sugar','Sugar / simple syrup','Pantry',29), ('bitters','Angostura bitters','Pantry',30), ('grenadine','Grenadine','Pantry',31)
on conflict (key) do nothing;

do $$
begin
  if not exists (select 1 from public.seed_log where key = 'gizmo-needs-v1') then
    update public.menu_items m set needs = v.needs from (values
      ('Gin & Tonic / Bacardi & Coke etc.', '{mixers}'::text[]),
      ('Dry Martini', '{gin,dry_vermouth}'), ('Tom Collins', '{gin,lemons,sugar,soda}'),
      ('Martinez', '{gin,sweet_vermouth,bitters,cherries}'), ('Negroni', '{gin,campari,sweet_vermouth}'),
      ('French 75', '{gin,lemons,sugar,sparkling}'), ('Kir Royale', '{cassis,sparkling}'),
      ('Cosmopolitan', '{vodka,triple_sec,limes,cranberry}'), ('Moscow Mule', '{vodka,limes,ginger_beer}'),
      ('Caesar', '{vodka,clamato}'), ('Screwdriver', '{vodka,orange_juice}'),
      ('Tequila Sunrise', '{tequila,orange_juice,grenadine}'), ('Margarita', '{tequila,triple_sec,limes}'),
      ('Mojito', '{light_rum,mint,sugar,limes,soda}'),
      ('Hurricane', '{light_rum,dark_rum,navy_rum,sugar,passion_pineapple,orange_juice,limes,grenadine}'),
      ('Daiquiri', '{light_rum,limes,sugar}'), ('Manhattan', '{whiskey,sweet_vermouth,bitters}'),
      ('Old Fashioned', '{whiskey,sugar,bitters}'), ('Whisky Mac', '{scotch,ginger_wine}'),
      ('Brandy Sangaree', '{brandy,port,sugar}')
    ) as v(name, needs) where m.name = v.name;
    insert into public.seed_log (key) values ('gizmo-needs-v1');
  end if;
end $$;

-- place_order now also refuses drinks with a missing ingredient.
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
  if exists (select 1 from public.ingredients where key = any(item.needs) and not in_stock) then
    raise exception 'SOLD_OUT';
  end if;
  if item.stock is not null then
    update public.menu_items set stock = stock - 1, available = (stock - 1) > 0 where id = item.id;
  end if;
  insert into public.orders (guest_name, item_id, item_name, notes)
    values (left(trim(p_name), 40), item.id, item.name, left(coalesce(trim(p_notes), ''), 200))
    returning * into o;
  return o;
end $$;
revoke execute on function public.place_order(text, uuid, text) from public, anon, authenticated;
grant execute on function public.place_order(text, uuid, text) to service_role;

-- Recipes: one row per ingredient ({key, amt, as}). The recipe is the source of truth:
-- a trigger derives the guest-facing description and the stock "needs" from it.
-- Rows whose amount says garnish / optional / to taste don't switch a drink off.
alter table public.menu_items add column if not exists recipe jsonb not null default '[]';

insert into public.ingredients (key, name, grp, sort) values
  ('oranges','Oranges','Fruit & garnish',29), ('celery','Celery','Fruit & garnish',30),
  ('hot_sauce','Tabasco / Worcestershire','Pantry',40), ('salt','Salt','Pantry',41), ('nutmeg','Nutmeg','Pantry',42)
on conflict (key) do nothing;

create or replace function public.recipe_row_optional(amt text) returns boolean
language sql immutable as $$ select coalesce(amt, '') ~* '(garnish|optional|taste)' $$;

create or replace function public.menu_items_from_recipe() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if jsonb_typeof(new.recipe) = 'array' and jsonb_array_length(new.recipe) > 0 then
    select coalesce(array_agg(distinct r->>'key') filter (
             where coalesce(r->>'key', '') <> '' and not public.recipe_row_optional(r->>'amt')), '{}'),
           left(coalesce(string_agg(
             case when coalesce(r->>'amt', '') = '' then lbl
                  when (r->>'amt') ~* '^(to |garnish|optional)' then lbl || ', ' || (r->>'amt')
                  else (r->>'amt') || ' ' || lbl end, ' · ' order by ord), ''), 500)
      into new.needs, new.description
      from (select r, ord, coalesce(nullif(trim(r->>'as'), ''), i.name, '') as lbl
              from jsonb_array_elements(new.recipe) with ordinality as e(r, ord)
              left join public.ingredients i on i.key = r->>'key') x;
  end if;
  return new;
end $$;
drop trigger if exists menu_items_recipe on public.menu_items;
create trigger menu_items_recipe before insert or update of recipe on public.menu_items
  for each row execute function public.menu_items_from_recipe();

do $$
begin
  if not exists (select 1 from public.seed_log where key = 'gizmo-recipe-v1') then
    update public.menu_items m set recipe = v.recipe from (values
      ('Gin & Tonic / Bacardi & Coke etc.', '[{"key": "", "amt": "1 oz", "as": "Gin, rum or vodka"}, {"key": "mixers", "amt": "3 oz", "as": "Tonic or cola"}, {"key": "lemons", "amt": "garnish", "as": "Lemon slice"}]'::jsonb),
      ('Dry Martini', '[{"key": "gin", "amt": "2 oz", "as": ""}, {"key": "dry_vermouth", "amt": "1/2 oz", "as": ""}, {"key": "bitters", "amt": "1 dash", "as": ""}, {"key": "lemons", "amt": "garnish", "as": "Lemon twist"}]'::jsonb),
      ('Tom Collins', '[{"key": "gin", "amt": "2 oz", "as": "Dry gin"}, {"key": "lemons", "amt": "1 oz", "as": "Lemon juice"}, {"key": "sugar", "amt": "1/2 oz", "as": "Simple syrup"}, {"key": "soda", "amt": "to top", "as": ""}, {"key": "lemons", "amt": "garnish", "as": "Lemon slice"}, {"key": "cherries", "amt": "garnish", "as": "Maraschino cherry"}]'::jsonb),
      ('Martinez', '[{"key": "gin", "amt": "1 oz", "as": ""}, {"key": "sweet_vermouth", "amt": "1 oz", "as": ""}, {"key": "bitters", "amt": "3 dashes", "as": ""}, {"key": "cherries", "amt": "1 tsp", "as": "Maraschino juice"}, {"key": "lemons", "amt": "garnish", "as": "Lemon twist"}]'::jsonb),
      ('Negroni', '[{"key": "gin", "amt": "1 oz", "as": ""}, {"key": "campari", "amt": "1 oz", "as": ""}, {"key": "sweet_vermouth", "amt": "1 oz", "as": ""}, {"key": "oranges", "amt": "garnish", "as": "Orange peel"}]'::jsonb),
      ('French 75', '[{"key": "gin", "amt": "1 oz", "as": ""}, {"key": "lemons", "amt": "1/2 oz", "as": "Lemon juice"}, {"key": "sugar", "amt": "1/2 oz", "as": "Simple syrup"}, {"key": "sparkling", "amt": "3 oz", "as": ""}, {"key": "lemons", "amt": "garnish", "as": "Lemon twist"}]'::jsonb),
      ('Kir Royale', '[{"key": "cassis", "amt": "1/2 oz", "as": ""}, {"key": "sparkling", "amt": "to top", "as": ""}]'::jsonb),
      ('Cosmopolitan', '[{"key": "vodka", "amt": "1 1/2 oz", "as": ""}, {"key": "triple_sec", "amt": "3/4 oz", "as": ""}, {"key": "limes", "amt": "3/4 oz", "as": "Lime juice"}, {"key": "cranberry", "amt": "1/2 oz", "as": ""}, {"key": "limes", "amt": "garnish", "as": "Lime wedge"}]'::jsonb),
      ('Moscow Mule', '[{"key": "vodka", "amt": "2 oz", "as": ""}, {"key": "limes", "amt": "1/2 oz", "as": "Lime juice"}, {"key": "ginger_beer", "amt": "3 oz", "as": ""}, {"key": "limes", "amt": "garnish", "as": "Lime slice"}]'::jsonb),
      ('Caesar', '[{"key": "vodka", "amt": "2 oz", "as": ""}, {"key": "clamato", "amt": "4 oz", "as": "Clamato juice"}, {"key": "hot_sauce", "amt": "to taste", "as": ""}, {"key": "limes", "amt": "garnish", "as": "Lime or lemon slice"}, {"key": "celery", "amt": "optional", "as": "Celery stalk"}]'::jsonb),
      ('Screwdriver', '[{"key": "vodka", "amt": "1 1/2 oz", "as": ""}, {"key": "orange_juice", "amt": "to top", "as": ""}]'::jsonb),
      ('Tequila Sunrise', '[{"key": "tequila", "amt": "2 oz", "as": ""}, {"key": "orange_juice", "amt": "4 oz", "as": ""}, {"key": "grenadine", "amt": "1/4 oz", "as": ""}, {"key": "oranges", "amt": "garnish", "as": "Orange slice"}, {"key": "cherries", "amt": "garnish", "as": "Cherry"}]'::jsonb),
      ('Margarita', '[{"key": "tequila", "amt": "1 1/2 oz", "as": ""}, {"key": "triple_sec", "amt": "1/2 oz", "as": ""}, {"key": "limes", "amt": "1 oz", "as": "Lime juice"}, {"key": "limes", "amt": "garnish", "as": "Lime slice"}, {"key": "salt", "amt": "optional", "as": "Salt rim"}]'::jsonb),
      ('Mojito', '[{"key": "mint", "amt": "3", "as": "Mint leaves"}, {"key": "sugar", "amt": "1/2 oz", "as": "Simple syrup"}, {"key": "light_rum", "amt": "2 oz", "as": "White rum"}, {"key": "limes", "amt": "3/4 oz", "as": "Lime juice"}, {"key": "soda", "amt": "to top", "as": ""}, {"key": "mint", "amt": "garnish", "as": "Mint sprig"}, {"key": "limes", "amt": "garnish", "as": "Lime slice"}]'::jsonb),
      ('Hurricane', '[{"key": "light_rum", "amt": "1 oz", "as": ""}, {"key": "dark_rum", "amt": "1 oz", "as": ""}, {"key": "navy_rum", "amt": "1 oz", "as": ""}, {"key": "sugar", "amt": "1/2 oz", "as": "Simple syrup"}, {"key": "passion_pineapple", "amt": "1/2 oz", "as": "Passion fruit pur\u00e9e or pineapple juice"}, {"key": "orange_juice", "amt": "1 oz", "as": ""}, {"key": "limes", "amt": "1 oz", "as": "Lime juice"}, {"key": "grenadine", "amt": "1/2 tsp", "as": ""}, {"key": "oranges", "amt": "garnish", "as": "Orange slice"}, {"key": "cherries", "amt": "garnish", "as": "Cherry"}]'::jsonb),
      ('Daiquiri', '[{"key": "light_rum", "amt": "2 oz", "as": "Light rum"}, {"key": "limes", "amt": "1 oz", "as": "Lime juice"}, {"key": "sugar", "amt": "3/4 oz", "as": "Demerara syrup"}, {"key": "limes", "amt": "garnish", "as": "Lime twist"}]'::jsonb),
      ('Manhattan', '[{"key": "whiskey", "amt": "2 oz", "as": "Rye whiskey"}, {"key": "sweet_vermouth", "amt": "1 oz", "as": ""}, {"key": "bitters", "amt": "2 dashes", "as": ""}, {"key": "cherries", "amt": "garnish", "as": "Brandied cherry or lemon slice"}]'::jsonb),
      ('Old Fashioned', '[{"key": "sugar", "amt": "1 tsp", "as": "Sugar"}, {"key": "bitters", "amt": "3 dashes", "as": ""}, {"key": "", "amt": "1 tsp", "as": "Water"}, {"key": "whiskey", "amt": "2 oz", "as": "Bourbon or rye"}, {"key": "oranges", "amt": "garnish", "as": "Orange twist"}]'::jsonb),
      ('Whisky Mac', '[{"key": "scotch", "amt": "1 1/2 oz", "as": "Blended Scotch"}, {"key": "ginger_wine", "amt": "1 oz", "as": "Stone''s green ginger wine"}]'::jsonb),
      ('Brandy Sangaree', '[{"key": "sugar", "amt": "1/2 tsp", "as": "Sugar"}, {"key": "", "amt": "1 tsp", "as": "Water"}, {"key": "brandy", "amt": "2 oz", "as": ""}, {"key": "port", "amt": "1 oz", "as": "Port wine"}, {"key": "nutmeg", "amt": "garnish", "as": "Grated nutmeg"}]'::jsonb)
    ) as v(name, recipe) where m.name = v.name and m.recipe = '[]'::jsonb;
    insert into public.seed_log (key) values ('gizmo-recipe-v1');
  end if;
end $$;

-- Wine by the glass (Jas, 2026-11-24). Bubbly uses the existing sparkling wine stock.
insert into public.ingredients (key, name, grp, sort) values
  ('white_wine','White wine','Liqueurs & wine',16), ('red_wine','Red wine','Liqueurs & wine',16), ('rose_wine','Rosé wine','Liqueurs & wine',16)
on conflict (key) do nothing;
do $$
begin
  if not exists (select 1 from public.seed_log where key = 'wine-by-glass-v1') then
    insert into public.menu_items (name, category, sort, image, tags, recipe, available)
    select v.name, 'By the glass', v.sort, v.image, v.tags, v.recipe, true from (values
      ('Glass of white wine', 101, 'drinks/wine-white.svg', '["light","dry"]'::jsonb, '[{"key":"white_wine","amt":"1 glass","as":"White wine, chilled"}]'::jsonb),
      ('Glass of red wine',   102, 'drinks/wine-red.svg',   '["warming"]'::jsonb,     '[{"key":"red_wine","amt":"1 glass","as":"Red wine"}]'::jsonb),
      ('Glass of rosé',       103, 'drinks/wine-rose.svg',  '["fruity","light"]'::jsonb, '[{"key":"rose_wine","amt":"1 glass","as":"Rosé, chilled"}]'::jsonb),
      ('Glass of bubbly',     104, 'drinks/wine-bubbly.svg','["fizzy","bubbly"]'::jsonb, '[{"key":"sparkling","amt":"1 glass","as":"Sparkling wine, chilled"}]'::jsonb)
    ) as v(name, sort, image, tags, recipe)
    where not exists (select 1 from public.menu_items m where m.name = v.name);
    insert into public.seed_log (key) values ('wine-by-glass-v1');
  end if;
end $$;

-- Richer stock (Jas, 2026-11-24): "running low" (still orderable, a heads-up for Gizmo)
-- and an optional top-shelf bottle per ingredient that guests can ask for.
alter table public.ingredients add column if not exists low boolean not null default false;
alter table public.ingredients add column if not exists top_shelf text check (top_shelf is null or char_length(top_shelf) <= 60);
alter table public.orders add column if not exists top_shelf text;

create or replace function public.place_order(p_name text, p_item uuid, p_notes text, p_top boolean)
returns public.orders
language plpgsql security definer set search_path = public as $$
declare
  item public.menu_items;
  o public.orders;
  bottle text;
begin
  if not public.bar_is_open() then raise exception 'BAR_CLOSED'; end if;
  select * into item from public.menu_items where id = p_item for update;
  if not found then raise exception 'NO_SUCH_DRINK'; end if;
  if not item.available or item.stock = 0 then raise exception 'SOLD_OUT'; end if;
  if exists (select 1 from public.ingredients where key = any(item.needs) and not in_stock) then
    raise exception 'SOLD_OUT';
  end if;
  if p_top then
    select string_agg(i.top_shelf, ', ' order by i.sort) into bottle
      from public.ingredients i where i.key = any(item.needs) and nullif(trim(i.top_shelf), '') is not null;
  end if;
  if item.stock is not null then
    update public.menu_items set stock = stock - 1, available = (stock - 1) > 0 where id = item.id;
  end if;
  insert into public.orders (guest_name, item_id, item_name, notes, top_shelf)
    values (left(trim(p_name), 40), item.id, item.name, left(coalesce(trim(p_notes), ''), 200), bottle)
    returning * into o;
  return o;
end $$;
revoke execute on function public.place_order(text, uuid, text, boolean) from public, anon, authenticated;
grant execute on function public.place_order(text, uuid, text, boolean) to service_role;

-- Keep the 3-argument version working (older function deploys, smoke tests).
create or replace function public.place_order(p_name text, p_item uuid, p_notes text)
returns public.orders
language sql security definer set search_path = public as $$
  select public.place_order(p_name, p_item, p_notes, false)
$$;
revoke execute on function public.place_order(text, uuid, text) from public, anon, authenticated;
grant execute on function public.place_order(text, uuid, text) to service_role;

-- Crew leaderboard (Jas, 2026-11-24). One row per drink ordered, kept apart from orders so
-- "Clear finished" doesn't wipe the board. All-time only. Names count exactly as typed
-- (only stray spaces are ignored); Gizmo merges duplicates by hand in admin.
create table if not exists public.tallies (
  id bigint generated always as identity primary key,
  name_key text not null,
  display text not null,
  created_at timestamptz not null default now()
);
create index if not exists tallies_created_idx on public.tallies (created_at);
alter table public.tallies enable row level security;
alter table public.settings add column if not exists show_board boolean not null default true;

create or replace function public.name_key(n text) returns text
language sql immutable as $$ select regexp_replace(trim(coalesce(n, '')), '\s+', ' ', 'g') $$;

create or replace function public.add_tally() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.tallies (name_key, display, created_at)
    values (public.name_key(new.guest_name), trim(new.guest_name), new.created_at);
  return new;
end $$;
drop trigger if exists orders_tally on public.orders;
create trigger orders_tally after insert on public.orders for each row execute function public.add_tally();

do $$
begin
  if not exists (select 1 from public.seed_log where key = 'tallies-backfill-v1') then
    insert into public.tallies (name_key, display, created_at)
      select public.name_key(guest_name), trim(guest_name), created_at from public.orders;
    insert into public.seed_log (key) values ('tallies-backfill-v1');
  end if;
end $$;

-- "Tonight" runs from 6 AM to 6 AM in the bar's time zone, so a late night counts as one night.
create or replace function public.leaderboard(p_scope text)
returns table (name text, drinks bigint)
language sql stable security definer set search_path = public as $$
  with b as (
    select case when p_scope = 'tonight'
      then (date_trunc('day', (now() at time zone s.timezone) - interval '6 hours') + interval '6 hours') at time zone s.timezone
      else '-infinity'::timestamptz end as since
    from public.settings s where s.id = 1 and s.show_board
  )
  select (array_agg(t.display order by t.created_at desc))[1], count(*)
    from public.tallies t, b
   where t.created_at >= b.since
   group by t.name_key
   order by count(*) desc, max(t.created_at) asc
   limit 10
$$;
grant execute on function public.leaderboard(text) to anon, authenticated;

create or replace function public.reset_leaderboard() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.tallies where true;
end $$;
grant execute on function public.reset_leaderboard() to anon, authenticated;

-- Jas (2026-11-24): exact names, no automatic merging. Re-key rows made by the earlier version.
do $$
begin
  if not exists (select 1 from public.seed_log where key = 'tallies-exact-v1') then
    update public.tallies set name_key = public.name_key(display), display = public.name_key(display) where true;
    insert into public.seed_log (key) values ('tallies-exact-v1');
  end if;
end $$;

-- Merges are stored as links (alias -> canonical name), so they can be undone.
create table if not exists public.name_aliases (
  alias text primary key,
  canonical text not null,
  created_at timestamptz not null default now()
);
alter table public.name_aliases enable row level security;
drop function if exists public.merge_names(text, text);
drop function if exists public.crew_names();

create or replace function public.leaderboard(p_scope text)
returns table (name text, drinks bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(a.canonical, t.name_key), count(*)
    from public.tallies t
    left join public.name_aliases a on a.alias = t.name_key
   where (select show_board from public.settings where id = 1)
   group by coalesce(a.canonical, t.name_key)
   order by count(*) desc, max(t.created_at) asc
   limit 10
$$;
grant execute on function public.leaderboard(text) to anon, authenticated;

-- Every name as typed, its own count, and what it's merged into (for the admin tool).
create or replace function public.crew_names()
returns table (name text, drinks bigint, merged_into text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  return query
    select n.k, coalesce(c.cnt, 0), a.canonical
      from (select name_key as k from public.tallies union select alias from public.name_aliases
            union select canonical from public.name_aliases) n
      left join (select name_key, count(*) cnt from public.tallies group by name_key) c on c.name_key = n.k
      left join public.name_aliases a on a.alias = n.k
     order by lower(n.k), n.k;
end $$;
grant execute on function public.crew_names() to anon, authenticated;

create or replace function public.merge_names(p_from text, p_into text) returns void
language plpgsql security definer set search_path = public as $$
declare f text := public.name_key(p_from); t text;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  -- swapping direction: "into" was merged into "from", so free it first
  delete from public.name_aliases where alias = public.name_key(p_into) and canonical = f;
  -- merging into a name that is itself merged goes to its final name
  select coalesce((select canonical from public.name_aliases where alias = public.name_key(p_into)), public.name_key(p_into)) into t;
  if f = '' or t = '' or f = t then return; end if;
  update public.name_aliases set canonical = t where canonical = f;   -- keep chains flat
  insert into public.name_aliases (alias, canonical) values (f, t)
    on conflict (alias) do update set canonical = excluded.canonical;
  delete from public.name_aliases where alias = canonical;
end $$;
grant execute on function public.merge_names(text, text) to anon, authenticated;

create or replace function public.unmerge_name(p_alias text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.name_aliases where alias = public.name_key(p_alias);
end $$;
grant execute on function public.unmerge_name(text) to anon, authenticated;

create or replace function public.reset_leaderboard() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.tallies where true;
  delete from public.name_aliases where true;
end $$;
grant execute on function public.reset_leaderboard() to anon, authenticated;

-- Suggestion box (Jas, 2026-11-24): guests suggest features or drinks and thumbs-up others.
-- No accounts, so a "voter" is a random id each phone keeps; one vote per phone per idea.
create table if not exists public.requests (
  id uuid primary key default gen_random_uuid(),
  body text not null check (char_length(body) between 3 and 200),
  kind text not null default 'feature' check (kind in ('feature', 'drink')),
  author text not null default '' check (char_length(author) <= 40),
  voter text not null,
  status text not null default 'open' check (status in ('open', 'considering', 'done')),
  hidden boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.request_votes (
  request_id uuid not null references public.requests on delete cascade,
  voter text not null,
  created_at timestamptz not null default now(),
  primary key (request_id, voter)
);
alter table public.requests enable row level security;
alter table public.request_votes enable row level security;

create or replace function public.request_board(p_voter text, p_all boolean default false)
returns table (id uuid, body text, kind text, author text, status text, hidden boolean, votes bigint, mine boolean, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_all and not public.is_owner() then raise exception 'not allowed'; end if;
  return query
    select r.id, r.body, r.kind, r.author, r.status, r.hidden,
           (select count(*) from public.request_votes v where v.request_id = r.id),
           exists (select 1 from public.request_votes v where v.request_id = r.id and v.voter = p_voter),
           r.created_at
      from public.requests r
     where p_all or not r.hidden
     order by (r.status = 'done'), 7 desc, r.created_at desc
     limit 100;
end $$;
grant execute on function public.request_board(text, boolean) to anon, authenticated;

create or replace function public.add_request(p_body text, p_kind text, p_author text, p_voter text)
returns uuid
language plpgsql security definer set search_path = public as $$
declare new_id uuid;
begin
  if coalesce(p_voter, '') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_VOTER'; end if;
  if (select count(*) from public.requests where voter = p_voter and created_at > now() - interval '1 day') >= 5 then
    raise exception 'TOO_MANY';
  end if;
  insert into public.requests (body, kind, author, voter)
    values (left(trim(p_body), 200), case when p_kind = 'drink' then 'drink' else 'feature' end, left(trim(coalesce(p_author, '')), 40), p_voter)
    returning id into new_id;
  insert into public.request_votes (request_id, voter) values (new_id, p_voter);
  return new_id;
end $$;
grant execute on function public.add_request(text, text, text, text) to anon, authenticated;

create or replace function public.toggle_vote(p_id uuid, p_voter text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_voter, '') !~ '^[0-9a-f-]{36}$' then raise exception 'BAD_VOTER'; end if;
  delete from public.request_votes where request_id = p_id and voter = p_voter;
  if found then return false; end if;
  insert into public.request_votes (request_id, voter)
    select p_id, p_voter where exists (select 1 from public.requests where id = p_id and not hidden);
  return true;
end $$;
grant execute on function public.toggle_vote(uuid, text) to anon, authenticated;

create or replace function public.set_request(p_id uuid, p_status text, p_hidden boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  update public.requests set status = coalesce(p_status, status), hidden = coalesce(p_hidden, hidden) where id = p_id;
end $$;
grant execute on function public.set_request(uuid, text, boolean) to anon, authenticated;

-- Owner can delete a suggestion (votes cascade)
create or replace function public.delete_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.requests where id = p_id;
end $$;
grant execute on function public.delete_request(uuid) to anon, authenticated;

-- Leaderboard: owner can remove a name from the board (restorable; orders are kept).
create table if not exists public.board_hidden (
  name text primary key,
  created_at timestamptz not null default now()
);
alter table public.board_hidden enable row level security;

create or replace function public.leaderboard(p_scope text)
returns table (name text, drinks bigint)
language sql stable security definer set search_path = public as $$
  select coalesce(a.canonical, t.name_key), count(*)
    from public.tallies t
    left join public.name_aliases a on a.alias = t.name_key
   where (select show_board from public.settings where id = 1)
     and coalesce(a.canonical, t.name_key) not in (select h.name from public.board_hidden h)
   group by coalesce(a.canonical, t.name_key)
   order by count(*) desc, max(t.created_at) asc
   limit 10
$$;
grant execute on function public.leaderboard(text) to anon, authenticated;

drop function if exists public.crew_names();
create or replace function public.crew_names()
returns table (name text, drinks bigint, merged_into text, hidden boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  return query
    select n.k, coalesce(c.cnt, 0), a.canonical, exists (select 1 from public.board_hidden h where h.name = n.k)
      from (select name_key as k from public.tallies union select alias from public.name_aliases
            union select canonical from public.name_aliases union select b.name from public.board_hidden b) n
      left join (select name_key, count(*) cnt from public.tallies group by name_key) c on c.name_key = n.k
      left join public.name_aliases a on a.alias = n.k
     order by lower(n.k), n.k;
end $$;
grant execute on function public.crew_names() to anon, authenticated;

create or replace function public.hide_from_board(p_name text, p_hidden boolean) returns void
language plpgsql security definer set search_path = public as $$
declare k text := public.name_key(p_name);
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  k := coalesce((select canonical from public.name_aliases where alias = k), k);
  if p_hidden then insert into public.board_hidden (name) values (k) on conflict do nothing;
  else delete from public.board_hidden where name = k; end if;
end $$;
grant execute on function public.hide_from_board(text, boolean) to anon, authenticated;

create or replace function public.reset_leaderboard() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.tallies where true;
  delete from public.name_aliases where true;
  delete from public.board_hidden where true;
end $$;
grant execute on function public.reset_leaderboard() to anon, authenticated;

-- Ideas statuses (Jas, 2026-11-24): Open / In consideration / Done (replaces Planned).
alter table public.requests drop constraint if exists requests_status_check;
update public.requests set status = 'considering' where status = 'planned';
alter table public.requests add constraint requests_status_check check (status in ('open', 'considering', 'done'));

-- Owner can wipe every idea and vote.
create or replace function public.reset_requests() returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.request_votes where true;
  delete from public.requests where true;
end $$;
grant execute on function public.reset_requests() to anon, authenticated;

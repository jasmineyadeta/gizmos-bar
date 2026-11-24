-- End-to-end backend checks, run on every deploy against the live database.
-- Everything happens inside one transaction that is ROLLED BACK at the end, so no real
-- data changes, no orders reach Gizmo, and the real admin link is untouched.
-- Calls run as the same "anon" role the website uses, holding a throwaway admin key.
-- Each check raises 'FAIL: ...' if something is wrong; the deploy then fails.
begin;

-- Setup (as the database owner) ---------------------------------------------------------
update public.admin_key set key_hash = encode(sha256(convert_to('ci-e2e-key', 'UTF8')), 'hex') where id = 1;
update public.ingredients set in_stock = true, low = false, top_shelf = null where true;
update public.menu_items set available = true, stock = null where true;
update public.settings set mode = 'open', show_board = true where id = 1;
delete from public.tallies where true;
delete from public.name_aliases where true;
delete from public.board_hidden where true;

-- A cocktail that needs a spirit, and a glass of wine.
select set_config('e2e.drink', (select m.id::text from public.menu_items m
  where m.category <> 'By the glass' and exists (select 1 from public.ingredients i where i.key = any(m.needs) and i.grp = 'Spirits')
  order by m.sort limit 1), true);
select set_config('e2e.spirit', (select i.key from public.menu_items m join public.ingredients i on i.key = any(m.needs) and i.grp = 'Spirits'
  where m.id = current_setting('e2e.drink')::uuid order by i.sort limit 1), true);
select set_config('e2e.wine', (select id::text from public.menu_items where category = 'By the glass' order by sort limit 1), true);
grant usage on schema public to anon;

-- From here on we are the website (anon) holding the admin link.
select set_config('request.headers', '{"x-bar-key":"ci-e2e-key"}', true);
set local role anon;

do $$ begin
  if current_setting('e2e.drink', true) is null or current_setting('e2e.wine', true) is null then raise exception 'FAIL: menu has no cocktail or no wine'; end if;
  if not public.has_admin_key() then raise exception 'FAIL: admin link not recognised'; end if;
  if not public.is_owner() then raise exception 'FAIL: admin link is not treated as owner'; end if;
end $$;

-- Guest-visible data ----------------------------------------------------------------------
do $$ begin
  if (select count(*) from public.menu_items) < 10 then raise exception 'FAIL: guests see fewer than 10 drinks'; end if;
  if (select count(*) from public.ingredients) < 10 then raise exception 'FAIL: guests cannot read ingredients'; end if;
  if (select count(*) from public.settings) <> 1 then raise exception 'FAIL: guests cannot read settings'; end if;
end $$;

-- Hours / open-closed -------------------------------------------------------------------
do $$ begin
  update public.settings set mode = 'closed' where id = 1;
  if public.bar_is_open() then raise exception 'FAIL: closed mode still open'; end if;
  update public.settings set mode = 'auto', schedule = (select jsonb_object_agg(d::text, '{"on":true,"open":"00:00","close":"23:59"}'::jsonb) from generate_series(0,6) d) where id = 1;
  if not public.bar_is_open() then raise exception 'FAIL: all-day schedule shows closed'; end if;
  update public.settings set schedule = (select jsonb_object_agg(d::text, '{"on":false,"open":"17:00","close":"22:00"}'::jsonb) from generate_series(0,6) d) where id = 1;
  if public.bar_is_open() then raise exception 'FAIL: no-days schedule shows open'; end if;
  update public.settings set mode = 'open' where id = 1;
end $$;

-- Stock levels and auto-off -------------------------------------------------------------
do $$ declare n int; begin
  update public.ingredients set in_stock = false where key = current_setting('e2e.spirit');
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: admin could not mark an ingredient Out'; end if;
end $$;

-- Orders run as the edge function does (service_role).
reset role;
set local role service_role;
do $$ begin
  begin
    perform public.place_order('CI Ray', current_setting('e2e.drink')::uuid, '', false);
    raise exception 'FAIL: ordered a drink whose spirit is Out';
  exception when others then
    if sqlerrm <> 'SOLD_OUT' then raise; end if;
  end;
end $$;
reset role;
set local role anon;
do $$ begin
  update public.ingredients set in_stock = true, low = true, top_shelf = 'CI Reserve' where key = current_setting('e2e.spirit');
end $$;
reset role;
set local role service_role;
do $$ declare o public.orders; begin
  o := public.place_order('CI Ray', current_setting('e2e.drink')::uuid, 'easy ice', false);
  if o.top_shelf is not null then raise exception 'FAIL: top shelf set without asking'; end if;
  o := public.place_order('CI Ray', current_setting('e2e.drink')::uuid, '', true);
  if coalesce(o.top_shelf, '') <> 'CI Reserve' then raise exception 'FAIL: top shelf bottle not on the order (got %)', o.top_shelf; end if;
  o := public.place_order('CI ray', current_setting('e2e.wine')::uuid, '', false);
  if o.item_name is null then raise exception 'FAIL: wine order failed'; end if;
  o := public.place_order('CI Sandy', current_setting('e2e.drink')::uuid, '', false);
  begin
    perform public.place_order('CI Ray', '00000000-0000-0000-0000-000000000000', '', false);
    raise exception 'FAIL: unknown drink accepted';
  exception when others then if sqlerrm <> 'NO_SUCH_DRINK' then raise; end if;
  end;
end $$;
reset role;
update public.settings set mode = 'closed' where id = 1;
set local role service_role;
do $$ begin
  begin
    perform public.place_order('CI Ray', current_setting('e2e.drink')::uuid, '', false);
    raise exception 'FAIL: ordered while closed';
  exception when others then if sqlerrm <> 'BAR_CLOSED' then raise; end if;
  end;
end $$;
reset role;
update public.settings set mode = 'open' where id = 1;
set local role anon;

-- Orders page (admin) and privacy (guests) -----------------------------------------------
do $$ declare n int; begin
  if (select count(*) from public.orders where guest_name like 'CI %') <> 4 then raise exception 'FAIL: admin does not see the 4 test orders'; end if;
  update public.orders set status = 'done' where guest_name = 'CI Sandy';
  delete from public.orders where status = 'done' and guest_name like 'CI %';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'FAIL: clearing finished orders removed % rows', n; end if;
end $$;
select set_config('request.headers', '{}', true);
do $$ begin
  if (select count(*) from public.orders) <> 0 then raise exception 'FAIL: guests can read orders'; end if;
  if public.is_owner() then raise exception 'FAIL: guest treated as owner'; end if;
  begin perform public.reset_leaderboard(); raise exception 'FAIL: guest reset the leaderboard';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.delete_request(gen_random_uuid()); raise exception 'FAIL: guest deleted an idea';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
  begin perform public.reset_requests(); raise exception 'FAIL: guest reset the ideas';
  exception when others then if sqlerrm <> 'not allowed' then raise; end if; end;
end $$;
select set_config('request.headers', '{"x-bar-key":"ci-e2e-key"}', true);

-- Recipe editor -------------------------------------------------------------------------
do $$ declare m public.menu_items; begin
  insert into public.menu_items (name, category, recipe)
    values ('CI Test Sour', 'Gin', '[{"key":"gin","amt":"2 oz"},{"key":"lemons","amt":"3/4 oz"},{"key":"cherries","amt":"garnish"}]')
    returning * into m;
  if m.needs <> array['gin','lemons'] then raise exception 'FAIL: recipe needs = %', m.needs; end if;
  if m.description not like '2 oz Gin%' then raise exception 'FAIL: recipe summary = %', m.description; end if;
  update public.menu_items set recipe = '[{"key":"vodka","amt":"2 oz"}]' where id = m.id returning * into m;
  if m.needs <> array['vodka'] then raise exception 'FAIL: swapping the spirit did not update needs'; end if;
  delete from public.menu_items where id = m.id;
end $$;

-- Leaderboard: tally, merge, unmerge, remove, restore, reset ------------------------------
do $$ declare top text; n bigint; begin
  select name, drinks into top, n from public.leaderboard('all') limit 1;
  if top <> 'CI Ray' or n <> 2 then raise exception 'FAIL: leaderboard top is % (%)', top, n; end if;
  perform public.merge_names('CI ray', 'CI Ray');
  select drinks into n from public.leaderboard('all') where name = 'CI Ray';
  if n <> 3 then raise exception 'FAIL: merge gave % drinks', n; end if;
  if not exists (select 1 from public.crew_names() where name = 'CI ray' and merged_into = 'CI Ray') then raise exception 'FAIL: merge not listed'; end if;
  perform public.unmerge_name('CI ray');
  select drinks into n from public.leaderboard('all') where name = 'CI Ray';
  if n <> 2 then raise exception 'FAIL: unmerge gave % drinks', n; end if;
  perform public.hide_from_board('CI Ray', true);
  if exists (select 1 from public.leaderboard('all') where name = 'CI Ray') then raise exception 'FAIL: removed name still on board'; end if;
  perform public.hide_from_board('CI Ray', false);
  if not exists (select 1 from public.leaderboard('all') where name = 'CI Ray') then raise exception 'FAIL: restore did not bring name back'; end if;
  perform public.reset_leaderboard();
  if exists (select 1 from public.leaderboard('all')) then raise exception 'FAIL: reset left names on the board'; end if;
  if exists (select 1 from public.crew_names()) then raise exception 'FAIL: reset left names in admin'; end if;
end $$;

-- Suggestion box --------------------------------------------------------------------------
do $$ declare a uuid; v1 text := gen_random_uuid()::text; v2 text := gen_random_uuid()::text; r record; begin
  a := public.add_request('CI espresso martini', 'drink', 'CI Sandy', v1);
  select * into r from public.request_board(v1) where id = a;
  if r.votes <> 1 or not r.mine then raise exception 'FAIL: new idea should have my 1 vote'; end if;
  perform public.toggle_vote(a, v2);
  if (select votes from public.request_board(v2) where id = a) <> 2 then raise exception 'FAIL: thumbs-up not counted'; end if;
  perform public.toggle_vote(a, v2);
  if (select votes from public.request_board(v2) where id = a) <> 1 then raise exception 'FAIL: un-thumbs-up not counted'; end if;
  perform public.set_request(a, 'considering', null);
  if (select status from public.request_board(v1) where id = a) <> 'considering' then raise exception 'FAIL: could not mark in consideration'; end if;
  perform public.set_request(a, 'done', null);
  if (select status from public.request_board(v1) where id = a) <> 'done' then raise exception 'FAIL: could not mark done'; end if;
  perform public.set_request(a, null, true);
  if exists (select 1 from public.request_board(v1) where id = a) then raise exception 'FAIL: hidden idea visible to guests'; end if;
  if not exists (select 1 from public.request_board(v1, true) where id = a) then raise exception 'FAIL: hidden idea missing in admin'; end if;
  perform public.set_request(a, null, false);
  if not exists (select 1 from public.request_board(v1) where id = a) then raise exception 'FAIL: unhide did not show the idea again'; end if;
  perform public.delete_request(a);
  if exists (select 1 from public.request_board(v1, true) where id = a) then raise exception 'FAIL: delete did not remove idea'; end if;
  for i in 1..5 loop perform public.add_request('CI idea ' || i, 'feature', '', v1); end loop;
  begin perform public.add_request('CI idea 6', 'feature', '', v1); raise exception 'FAIL: spam limit not enforced';
  exception when others then if sqlerrm <> 'TOO_MANY' then raise; end if; end;
end $$;

-- Barcode scanning: admin remembers a bottle, guests can't see the list -------------------
do $$ begin
  insert into public.barcodes (code, ingredient_key, product) values ('0000000000017', current_setting('e2e.spirit'), 'CI Bottle');
  if (select ingredient_key from public.barcodes where code = '0000000000017') <> current_setting('e2e.spirit') then raise exception 'FAIL: barcode not remembered'; end if;
  update public.barcodes set product = 'CI Bottle 2' where code = '0000000000017';
end $$;
select set_config('request.headers', '{}', true);
do $$ begin
  if exists (select 1 from public.barcodes) then raise exception 'FAIL: guests can read barcodes'; end if;
  begin insert into public.barcodes (code, ingredient_key) values ('0000000000024', 'gin'); raise exception 'FAIL: guest saved a barcode';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.headers', '{"x-bar-key":"ci-e2e-key"}', true);

-- Push alerts: at least the setup exists (sending is checked separately) ------------------
reset role;
do $$ begin
  if not exists (select 1 from public.app_config where key = 'vapid_public') then raise exception 'FAIL: push keys missing'; end if;
end $$;

select 'ALL CHECKS PASSED' as result,
       (select count(*) from public.push_subscriptions) as phones_with_alerts;
rollback;

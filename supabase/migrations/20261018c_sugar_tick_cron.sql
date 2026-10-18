-- Every 5 minutes: each su94r user with an Echo Show tile gets their person's new reading
-- (workers/sugar.js sugarTick). sugar/tick needs no secret: it only refreshes tiles.
select cron.schedule('su94r-sugar-tick', '*/5 * * * *', $$select net.http_post(url := 'https://sfelhasepvaoianyuvxe.supabase.co/functions/v1/su94r-cgm/sugar/tick', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000)$$);

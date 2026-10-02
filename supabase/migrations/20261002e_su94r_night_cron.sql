-- Runs the night safety net (workers/night.js) every 5 minutes. night/tick needs no secret:
-- it runs at most every 4 minutes whoever calls it, and answers with counts only.
select cron.schedule('su94r-night-tick', '*/5 * * * *', $$select net.http_post(url := 'https://sfelhasepvaoianyuvxe.supabase.co/functions/v1/su94r-cgm/night/tick', headers := '{"Content-Type":"application/json"}'::jsonb, body := '{}'::jsonb, timeout_milliseconds := 30000)$$);

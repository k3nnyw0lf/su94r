-- The Echo Show home-screen tile (workers/widget.js): the Amazon user id Alexa sends when the
-- My Sugar tile is added (Alexa.DataStore.PackageManager.UsagesInstalled). The night tick
-- sends each new reading to that user's Echo devices with the Data Store API.
alter table public.su94r_night
  add column if not exists alexa_widget_user text;

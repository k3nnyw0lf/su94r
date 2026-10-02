# Privacy

su94r has no ads, no analytics trackers and does not sell or share data. This page says
exactly where your data goes. It covers the su94r.com site, the su94r Mini Chrome extension
and the optional Workers in this repo. If you run your own copy, you decide where things go.

## The app (su94r.com)

| Data | Where it goes |
|---|---|
| Your CGM login (LibreLinkUp, Dexcom Share) and readings | Through the su94r proxy to your CGM service and back. The proxy does not keep or log them. |
| Your Nightscout address and token | Through the proxy to your Nightscout and back. |
| Logs, settings, photos for progress tracking | Kept in your browser. If you sign in, logs and settings sync to your own account in the su94r database, readable only by you. |
| Questions to the AI agents | Sent with a summary of your data to the AI service you picked (Groq, Google, Mistral, Hugging Face, Anthropic, OpenAI or your own Ollama). That service's terms apply. |
| Posture and equipment photos | Sent to Google Gemini for one assessment. su94r keeps no copy; on the free tier Google may keep and review what is sent. |
| Weather | Your approximate location goes to Open-Meteo, only if you allow location. |
| Food and drug lookups | Your search words go to USDA FoodData Central, OpenFDA and PubMed. |

API keys you type into Settings stay in your browser and are sent only to the service they
belong to.

## su94r Mini (Chrome extension)

- Signs in to LibreLinkUp directly from your browser. Your password is used once to sign in
  and is not saved; the session token is kept in the extension's local storage.
- Readings, doses, meals and notes are kept in the extension's storage in your browser.
- If Chrome sync is on, your markers (doses, meals, notes), shared settings and the list of
  your computers sync through your Google account to your other computers.
- Medicine search sends the words you type to the US National Library of Medicine (RxNav).
- AI analysis is off until you pick a service and agree. Then a summary of your readings and
  markers (no last name, no account details) goes to that service.
- The optional Windows "keep on top" helper only listens on your own computer (127.0.0.1).

## Big screen, Alexa and night monitor (optional, self-hosted)

These run on your own Cloudflare and Supabase accounts with a LibreLinkUp login you add as a
secret. The big-screen link is protected by a key you choose; anyone with the link can see the
readings. The Alexa skill speaks your reading on your own Echo devices. The night monitor
contacts only the caregivers who have agreed to it, and stops the moment one withdraws.

## Deleting your data

- App: Settings → clear data, or clear the site's data in your browser. If you signed in,
  ask through GitHub issues to delete your account and its rows.
- Extension: Settings → History → delete, or remove the extension.

## Contact

Open an issue at https://github.com/k3nnyw0lf/su94r/issues. Please do not post health data
in a public issue.

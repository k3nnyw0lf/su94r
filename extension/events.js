// Pages never write the marker list themselves. Every change goes to the background
// worker, which applies changes one at a time and sends them to the other computers,
// so two open windows (or a window and an incoming sync) cannot undo each other.

async function ask(message) {
  const r = await chrome.runtime.sendMessage(message);
  if (!r?.ok) throw new Error(r?.error || 'The extension did not answer. Try again.');
  return r;
}

export const addEvents = (events) => ask({ type: 'addEvents', events });
export const removeEvents = (ids) => ask({ type: 'removeEvents', ids });

import React from 'react';
import {
  Laptop, AppWindow, Refrigerator, Mic, ShieldCheck, BellRing, Syringe, ChartLine, Lock,
  Dumbbell, Moon, Watch, Users, ArrowRight, GitBranch, Puzzle, Check,
} from 'lucide-react';

const GITHUB = 'https://github.com/k3nnyw0lf/su94r';

/** Where your glucose shows up. Each one is real and in this repo. */
const PLACES = [
  {
    icon: Laptop,
    title: 'On your laptop',
    body: 'su94r Mini, a Chrome extension: a small always-on-top graph of your FreeStyle Libre, a board for a whole family or ward, and alarms.',
  },
  {
    icon: AppWindow,
    title: 'As a desktop widget',
    body: 'A rounded square on your Windows desktop with the number, the arrow and the last three hours. Drag it anywhere.',
  },
  {
    icon: Refrigerator,
    title: 'On the fridge and the TV',
    body: 'Open su94r.com/tv on a Samsung fridge, a TV or a tablet, type the code it shows into su94r Mini, done.',
  },
  {
    icon: Mic,
    title: 'Through Alexa',
    body: '“Alexa, tell my sugar 4 units of R insulin.” Alexa repeats it back, logs it after your yes, and tells you if you already took one.',
  },
];

const SAFETY = [
  {
    icon: Syringe,
    title: 'Never twice by mistake',
    body: 'Every dose you log on any computer or by voice is remembered everywhere. A second one inside the window asks you first, and shows what is still active.',
  },
  {
    icon: BellRing,
    title: 'Alarms that reach you',
    body: 'Urgent lows sound on the devices you choose. A low stays raised while readings are late, and a signed-out account raises its own alarm.',
  },
  {
    icon: ChartLine,
    title: 'Learns your insulin',
    body: 'From your own history: when your insulin starts, works hardest and is mostly done, with and without exercise. Timing only, never units.',
  },
  {
    icon: Lock,
    title: 'Yours, and open',
    body: 'Free, no ads, no trackers. Run it on your own accounts. Every line is on GitHub to read.',
  },
];

const APP = [
  { icon: Dumbbell, title: 'Training with a glucose gate', body: 'Each session checks your glucose first. Too low, and it tells you what to eat and when to re-check.' },
  { icon: Moon, title: 'The overnight drop', body: 'Evening training raises insulin sensitivity for hours. su94r watches that window and reminds you to check before bed.' },
  { icon: Watch, title: 'Your devices, connected', body: 'Pixel Watch and Fitbit through the Google Health API, Apple Health through a Shortcut, a Wyze scale.' },
  { icon: Users, title: 'A care circle', body: 'Family can be woken for a low that is not answered: lights, speakers, a text. Only people who agreed, and only when needed.' },
];

/** A still image of the widget, drawn in HTML so it is crisp on every screen. */
function WidgetPreview() {
  const pts = [150, 158, 166, 171, 169, 160, 148, 136, 128, 124, 121, 119, 118, 117, 116, 118];
  const w = 260, h = 70, lo = 70, hi = 210;
  const y = (v) => h - ((v - lo) / (hi - lo)) * h;
  const d = pts.map((v, i) => `${i ? 'L' : 'M'}${((i / (pts.length - 1)) * w).toFixed(1)},${y(v).toFixed(1)}`).join('');
  return (
    <div className="hw" aria-label="Example: 118 milligrams per deciliter, steady, 2 minutes ago">
      <div className="hw-top">
        <span className="hw-val">118</span>
        <svg className="hw-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h14M12.5 6l6 6-6 6" /></svg>
        <span className="hw-unit">mg/dL</span>
        <span className="hw-side"><b>−2 / 15 min</b><br />2 min ago</span>
      </div>
      <svg className="hw-graph" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x="0" y={y(180)} width={w} height={y(70) - y(180)} className="hw-band" />
        <path d={d} className="hw-line" />
        <circle cx={w} cy={y(pts[pts.length - 1])} r="4.5" className="hw-dot" />
      </svg>
    </div>
  );
}

function Card({ icon: Icon, title, body }) {
  return (
    <article className="h-card">
      <span className="h-card-icon"><Icon size={20} strokeWidth={2} aria-hidden="true" /></span>
      <h3 className="h-card-title">{title}</h3>
      <p className="h-card-body">{body}</p>
    </article>
  );
}

export default function Home({ user, onShowAuth, onEnter }) {
  return (
    <div className="home2">
      <header className="h-nav">
        <a className="h-brand" href="/" aria-label="su94r home">
          <img src="/logo.svg" alt="" width="30" height="30" />
          <span>su94r</span>
        </a>
        <nav className="h-links" aria-label="Page">
          <a href="#everywhere">Everywhere</a>
          <a href="#safety">Safety</a>
          <a href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub</a>
        </nav>
        <button className="h-btn h-btn-small" onClick={onEnter}>Open the app</button>
      </header>

      <section className="h-hero">
        <div className="h-hero-text">
          <p className="h-eyebrow">Open source · Type 1 diabetes</p>
          <h1 className="h-title">Your glucose,<br /><span className="h-grad">everywhere you look.</span></h1>
          <p className="h-lede">
            A live graph on your laptop, a widget on your desktop, your fridge and TV, and Alexa,
            with a double-dose guard that remembers every shot. Works with FreeStyle Libre,
            Dexcom and Nightscout. Free, built by someone who has it.
          </p>
          <div className="h-cta">
            <a className="h-btn" href={`${GITHUB}/tree/main/extension#readme`} target="_blank" rel="noopener noreferrer">
              <Puzzle size={18} aria-hidden="true" /> Get su94r Mini for Chrome
            </a>
            {user
              ? <button className="h-btn h-btn-ghost" onClick={onEnter}>Open the app <ArrowRight size={16} aria-hidden="true" /></button>
              : <button className="h-btn h-btn-ghost" onClick={onShowAuth}>Sign in with Google</button>}
          </div>
          <p className="h-note">
            {user
              ? `Signed in as ${user.email}.`
              : <>Or <button className="h-inline" onClick={onEnter}>use the web app without an account</button>: readings pass through the su94r proxy to reach your CGM service, and nothing else leaves your browser.</>}
          </p>
          <ul className="h-ticks">
            <li><Check size={15} aria-hidden="true" /> Free, no ads, no trackers</li>
            <li><Check size={15} aria-hidden="true" /> MIT licensed</li>
            <li><Check size={15} aria-hidden="true" /> Never suggests a dose</li>
          </ul>
        </div>
        <div className="h-hero-art">
          <WidgetPreview />
        </div>
      </section>

      <section className="h-section" id="everywhere">
        <h2 className="h-h2">Everywhere you look</h2>
        <div className="h-grid">{PLACES.map((c) => <Card key={c.title} {...c} />)}</div>
      </section>

      <section className="h-section" id="safety">
        <h2 className="h-h2">Built to keep you safe</h2>
        <div className="h-grid">{SAFETY.map((c) => <Card key={c.title} {...c} />)}</div>
      </section>

      <section className="h-section">
        <h2 className="h-h2">In the web app</h2>
        <div className="h-grid">{APP.map((c) => <Card key={c.title} {...c} />)}</div>
      </section>

      {/* Deliberately given the same weight as the features. A T1D app that
          buries its limits is not being honest about what it is. */}
      <section className="h-limits">
        <ShieldCheck size={22} aria-hidden="true" />
        <div>
          <h2 className="h-limits-title">What su94r will not do</h2>
          <p>
            It never recommends an insulin dose, a basal rate, or a pump setting. Those are
            decisions for you and your care team. It is not a medical device: readings can be
            late or missing, so keep your sensor app and its alarms on, and check with a
            fingerstick before treating. su94r is independent and is not made or endorsed by
            Abbott, Dexcom, Google, Apple, Amazon, Samsung or any device maker.
          </p>
        </div>
      </section>

      <section className="h-section h-open">
        <GitBranch size={22} aria-hidden="true" />
        <div>
          <h2 className="h-h2 h-h2-inline">Open source, and yours</h2>
          <p className="h-note">
            Every part, the app, su94r Mini, the widget, the screens and the Alexa skill, is on
            GitHub under the MIT license. Run it on your own accounts, or help: translations,
            devices and tests are welcome.
          </p>
          <a className="h-btn h-btn-ghost" href={GITHUB} target="_blank" rel="noopener noreferrer">See the code <ArrowRight size={16} aria-hidden="true" /></a>
        </div>
      </section>

      <footer className="h-foot">
        <span>su94r · MIT licensed</span>
        <a href={`${GITHUB}/blob/main/PRIVACY.md`} target="_blank" rel="noopener noreferrer">Privacy</a>
        <a href={`${GITHUB}/issues`} target="_blank" rel="noopener noreferrer">Report a problem</a>
        <span>Not a medical device</span>
      </footer>
    </div>
  );
}

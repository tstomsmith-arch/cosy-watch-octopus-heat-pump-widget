// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: purple; icon-glyph: temperature-high;

// ─────────────────────────────────────────────
// Cosy Watch — Octopus heat pump widget for Scriptable
//
// Shows hot water temperature, Cosy Pod room readings,
// live pump status with output and efficiency (COP),
// today's and yesterday's energy use, outdoor temperature,
// and fault warnings.
//
// Built and tested on an Octopus Cosy 9. It uses Octopus's
// unofficial heat pump API, so it may stop working if
// Octopus changes things.
//
// ── SETUP (about 5 minutes) ──
// 1. Get your API key: log in at octopus.energy, go to
//    Account → Personal details → API access, and copy
//    the key starting "sk_live_".
// 2. Paste it into API_KEY below, between the quotes.
// 3. Run this script once in Scriptable to check it works.
//    The first run finds your heat pump automatically and
//    may take a few seconds.
// 4. Add a Scriptable widget to your Home Screen (medium
//    size works best), long-press it → Edit Widget →
//    choose this script.
//
// Your account number and heat pump ID are found
// automatically and remembered. You can fill them in
// below instead if you prefer.
//
// PRIVACY: your API key gives full access to your Octopus
// account. Don't share this script with your key in it,
// and keep it out of screenshots.
// ─────────────────────────────────────────────

const API_KEY = "PASTE_YOUR_API_KEY_HERE";

// Optional — leave blank for automatic detection
const ACCOUNT_NUMBER = "";   // e.g. "A-1234ABCD"
const EUID = "";             // e.g. "00:1a:2b:3c:4d:5e:6f:70"

const TOKEN_URL = "https://api.octopus.energy/v1/graphql/";
const DATA_URL = "https://api.backend.octopus.energy/v1/graphql/";
const REFRESH_MINUTES = 10;

// Name each Cosy Pod after its room. Pod numbers follow the
// order they were paired (Pod 1 is usually the primary).
// Leave an entry as "" to show "Pod 1", "Pod 2" and so on.
const POD_NAMES = {
  1: "",
  2: "",
  3: "",
  4: ""
};

// Set to true to preview the widget with four made-up pods
// and the heating state, e.g. before your heating install.
// Set back to false for normal use.
const TEST_PODS = false;

// Opens when you tap the widget. Leave as "" to disable
// (tapping then runs the script instead, if set to Run Script).
const TAP_URL = "https://octopus.energy/dashboard/";

// Set to true to preview the fault display with a made-up
// code. Set back to false for normal use.
const TEST_FAULT = false;

// Set to true to fake water heating (shows the pink "Heating"
// label on the water tile and "Running" on the pump).
const TEST_WATER_HEATING = false;

// Set to true to fake central heating (shows "Heating" on the
// heating tile and "Running" on the pump).
const TEST_CENTRAL_HEATING = false;

// Sensor readings below this are unplugged probes, not real temps
const MIN_VALID_TEMP = -50;

// ── Octopus-inspired palette ──
const BG_TOP = new Color("#10002E");
const BG_MID = new Color("#22084F");
const BG_BOTTOM = new Color("#3A0F6B");
const PINK = new Color("#F050F8");
const CYAN = new Color("#5CE1E6");
const AMBER = new Color("#FFB020");
const YELLOW = new Color("#FFD60A");
const TEXT = Color.white();
const SUBTLE = new Color("#FFFFFF", 0.55);
const FAINT = new Color("#FFFFFF", 0.35);

// Simulated Liquid Glass. Scriptable can't do real blur,
// so each card gets a light-to-dark sheen and a bright
// top edge to mimic light hitting glass.
const GLASS_SHEEN_TOP = new Color("#FFFFFF", 0.20);
const GLASS_SHEEN_MID = new Color("#FFFFFF", 0.08);
const GLASS_SHEEN_BOTTOM = new Color("#FFFFFF", 0.03);
const GLASS_BORDER = new Color("#FFFFFF", 0.30);

// ─────────────────────────────────────────────
// API
// ─────────────────────────────────────────────

async function gql(url, query, variables, token) {
  const req = new Request(url);
  req.method = "POST";
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = token;
  req.headers = headers;
  req.body = JSON.stringify({ query, variables });
  // Give up after 12s so we fall back to saved data before
  // iOS times out the whole script.
  req.timeoutInterval = 12;
  const json = await req.loadJSON();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map(e => e.message).join(" | "));
  }
  return json.data;
}

async function getToken() {
  const data = await gql(
    TOKEN_URL,
    `mutation ($key: String!) {
       obtainKrakenToken(input: { APIKey: $key }) { token }
     }`,
    { key: API_KEY }
  );
  return data.obtainKrakenToken.token;
}

// Finds the account number and heat pump controller ID.
// Uses the constants if set, then the saved result of a
// previous run, then searches the account.
async function discoverIds(token) {
  if (ACCOUNT_NUMBER && EUID) {
    return { accountNumber: ACCOUNT_NUMBER, euid: EUID };
  }

  const CACHE_KEY = "cosy-widget-ids";
  if (Keychain.contains(CACHE_KEY)) {
    try {
      const cached = JSON.parse(Keychain.get(CACHE_KEY));
      if (cached.accountNumber && cached.euid) return cached;
    } catch (e) {
      // Ignore a bad cache and rediscover
    }
  }

  let accounts;
  if (ACCOUNT_NUMBER) {
    accounts = [ACCOUNT_NUMBER];
  } else {
    const acctData = await gql(
      TOKEN_URL,
      `query { viewer { accounts { number } } }`,
      {}, token
    );
    accounts = acctData.viewer.accounts.map(a => a.number);
  }

  for (const accountNumber of accounts) {
    let props = [];
    try {
      const propData = await gql(
        TOKEN_URL,
        `query ($accountNumber: String!) {
           account(accountNumber: $accountNumber) {
             properties { id }
           }
         }`,
        { accountNumber }, token
      );
      props = propData.account ? propData.account.properties : [];
    } catch (e) {
      continue;
    }

    for (const prop of props) {
      try {
        const ctrlData = await gql(
          DATA_URL,
          `query ($accountNumber: String!, $propertyId: ID!) {
             heatPumpControllersAtLocation(
               accountNumber: $accountNumber, propertyId: $propertyId
             ) {
               controller { euid }
             }
           }`,
          { accountNumber, propertyId: prop.id }, token
        );
        const list = ctrlData.heatPumpControllersAtLocation || [];
        if (list.length > 0 && list[0].controller && list[0].controller.euid) {
          const ids = { accountNumber, euid: list[0].controller.euid };
          Keychain.set(CACHE_KEY, JSON.stringify(ids));
          return ids;
        }
      } catch (e) {
        // Try the next property
      }
    }
  }

  throw new Error(
    "No Octopus heat pump found. Check your API key, and that " +
    "your heat pump shows under Devices in the Octopus app."
  );
}

async function getControllerStatus(token, ids) {
  const data = await gql(
    DATA_URL,
    `query ($accountNumber: String!, $euid: ID!) {
       heatPumpControllerStatus(accountNumber: $accountNumber, euid: $euid) {
         sensors {
           code
           connectivity { online }
           telemetry {
             temperatureInCelsius
             humidityPercentage
             retrievedAt
           }
         }
         zones {
           zone
           telemetry { setpointInCelsius mode heatDemand relaySwitchedOn }
         }
       }
     }`,
    { accountNumber: ids.accountNumber, euid: ids.euid },
    token
  );
  return data.heatPumpControllerStatus;
}

// One query for two things: fault codes, and which sensor
// is the hot water cylinder on this install.
async function getConfigInfo(token, ids) {
  const data = await gql(
    DATA_URL,
    `query ($accountNumber: String!, $euid: ID!) {
       heatPumpControllerConfiguration(
         accountNumber: $accountNumber, euid: $euid
       ) {
         heatPump { faultCodes model }
         zones {
           configuration { zoneType primarySensor }
         }
       }
     }`,
    { accountNumber: ids.accountNumber, euid: ids.euid },
    token
  );
  const cfg = data.heatPumpControllerConfiguration;
  if (!cfg) return { faults: [], waterSensor: null, model: null };

  let faults = [];
  if (cfg.heatPump && Array.isArray(cfg.heatPump.faultCodes)) {
    // Format unknown until a real fault appears, so stringify defensively
    faults = cfg.heatPump.faultCodes.map(c =>
      typeof c === "string" ? c : JSON.stringify(c)
    );
  }

  let model = null;
  if (cfg.heatPump && cfg.heatPump.model) model = cfg.heatPump.model;

  let waterSensor = null;
  const waterZone = (cfg.zones || []).find(
    z => z.configuration && z.configuration.zoneType === "WATER"
  );
  if (waterZone && waterZone.configuration.primarySensor) {
    waterSensor = waterZone.configuration.primarySensor;
  }

  return { faults, waterSensor, model };
}

async function getLivePerformance(token, ids) {
  const data = await gql(
    DATA_URL,
    `query ($accountNumber: String!, $euid: ID!) {
       heatPumpLivePerformance(accountNumber: $accountNumber, euid: $euid) {
         readAt
         powerInput { value }
         heatOutput { value }
         outdoorTemperature { value }
         coefficientOfPerformance
       }
     }`,
    { accountNumber: ids.accountNumber, euid: ids.euid },
    token
  );
  const p = data.heatPumpLivePerformance;
  if (!p) return null;
  const n = v => {
    if (v === null || v === undefined) return null;
    const f = parseFloat(v);
    return isNaN(f) ? null : f;
  };
  return {
    powerInput: n(p.powerInput ? p.powerInput.value : null),
    heatOutput: n(p.heatOutput ? p.heatOutput.value : null),
    outdoorTemp: n(p.outdoorTemperature ? p.outdoorTemperature.value : null),
    cop: n(p.coefficientOfPerformance)
  };
}

async function getRangedPerformance(token, ids, startAt, endAt) {
  const data = await gql(
    DATA_URL,
    `query ($accountNumber: String!, $euid: ID!,
            $startAt: DateTime!, $endAt: DateTime!) {
       heatPumpTimeRangedPerformance(
         accountNumber: $accountNumber, euid: $euid,
         startAt: $startAt, endAt: $endAt
       ) {
         energyInput { value }
         energyOutput { value }
         coefficientOfPerformance
       }
     }`,
    {
      accountNumber: ids.accountNumber,
      euid: ids.euid,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString()
    },
    token
  );
  const t = data.heatPumpTimeRangedPerformance;
  if (!t) return null;
  const n = v => {
    if (v === null || v === undefined) return null;
    const f = parseFloat(v);
    return isNaN(f) ? null : f;
  };
  return {
    energyIn: n(t.energyInput ? t.energyInput.value : null),
    energyOut: n(t.energyOutput ? t.energyOutput.value : null),
    cop: n(t.coefficientOfPerformance)
  };
}

// Yesterday's totals don't change during the day, so fetch
// them once and reuse the result until the date changes.
async function getYesterdayCached(token, ids, prevMidnight, midnight) {
  const KEY = "cosy-widget-yesterday";
  const day = midnight.toISOString().slice(0, 10);
  if (Keychain.contains(KEY)) {
    try {
      const cached = JSON.parse(Keychain.get(KEY));
      if (cached.day === day && cached.data) return cached.data;
    } catch (e) {
      // Ignore a bad cache and refetch
    }
  }
  const data = await getRangedPerformance(token, ids, prevMidnight, midnight);
  if (data) Keychain.set(KEY, JSON.stringify({ day, data }));
  return data;
}

// ─────────────────────────────────────────────
// Parsing
// ─────────────────────────────────────────────

function validTemp(t) {
  return t !== null && t !== undefined && t > MIN_VALID_TEMP;
}

function podName(num) {
  return POD_NAMES[num] || "Pod " + num;
}

function parseReadings(status, waterSensorCode) {
  const sensors = status.sensors || [];
  const zones = status.zones || [];

  // Hot water: the cylinder sensor for this install,
  // falling back to ADC1 (the code seen on a Cosy 9)
  const code = waterSensorCode || "ADC1";
  let water = null;
  const waterSensor = sensors.find(s => s.code === code);
  if (waterSensor && waterSensor.telemetry) {
    const t = waterSensor.telemetry.temperatureInCelsius;
    water = {
      temp: validTemp(t) ? t : null,
      online: waterSensor.connectivity
        ? waterSensor.connectivity.online : null
    };
  }

  // Water setpoint (negative sentinel means none active)
  let waterSetpoint = null;
  let waterMode = null;
  const waterZone = zones.find(z => z.zone === "WATER");
  if (waterZone && waterZone.telemetry) {
    const sp = waterZone.telemetry.setpointInCelsius;
    if (sp !== null && sp > 0) waterSetpoint = sp;
    waterMode = waterZone.telemetry.mode || null;
  }

  // Pods: SENSORxx codes with plausible readings
  const pods = sensors
    .filter(s => /^SENSOR\d+$/i.test(s.code))
    .filter(s => s.telemetry && validTemp(s.telemetry.temperatureInCelsius))
    .map(s => ({
      name: podName(parseInt(s.code.replace(/\D/g, ""), 10)),
      temp: s.telemetry.temperatureInCelsius,
      humidity: s.telemetry.humidityPercentage,
      online: s.connectivity ? s.connectivity.online : false
    }))
    .slice(0, 4);

  const anyOnline = sensors.some(
    s => s.connectivity && s.connectivity.online
  );

  // Activity: is the controller calling for heat right now?
  const zoneActive = z =>
    z.telemetry &&
    (z.telemetry.relaySwitchedOn === true || z.telemetry.heatDemand === true);
  const waterActive = waterZone ? zoneActive(waterZone) : false;
  const heatActive = zones.some(z => z.zone !== "WATER" && zoneActive(z));

  // If every zone's mode is OFF, nothing will start on its own
  const allOff = zones.length > 0 && zones.every(
    z => z.telemetry && z.telemetry.mode === "OFF"
  );

  return {
    water, waterSetpoint, waterMode, pods,
    connected: anyOnline, waterActive, heatActive, allOff
  };
}

// Footer status line and dot colour.
// Running = zone flags OR live power draw above 0.1 kW.
function statusLine(r) {
  if (r.faults && r.faults.length > 0) {
    return {
      text: "Fault " + r.faults.slice(0, 2).join(", "),
      colour: AMBER
    };
  }
  const p = r.perf;
  const drawingPower = p && p.powerInput !== null && p.powerInput > 0.1;
  const running = r.waterActive || r.heatActive || drawingPower;

  if (!r.connected && !running) return { text: "Offline", colour: FAINT };

  if (running) {
    let label = r.waterActive
      ? (r.waterMode === "BOOST" ? "Boosting water" : "Heating water")
      : (r.heatActive ? "Heating" : "Running");
    if (p && p.heatOutput !== null) {
      label += " · " + (Math.round(p.heatOutput * 10) / 10) + " kW";
    }
    if (p && p.cop !== null) {
      label += " · COP " + (Math.round(p.cop * 10) / 10);
    }
    return { text: label, colour: PINK };
  }

  let label = r.allOff ? "Off" : "Standby";
  if (p && p.outdoorTemp !== null) {
    label += " · Outside " + fmtTemp(p.outdoorTemp);
  }
  return { text: label, colour: CYAN };
}

// Next scheduled water slot as HH:MM, rolling to tomorrow
// if none remain today. Returns null if no schedule.
function fmtTemp(t) {
  if (t === null || t === undefined) return "--°";
  return Math.round(t * 10) / 10 + "°";
}

// ─────────────────────────────────────────────
// UI helpers
// ─────────────────────────────────────────────

function applyBackground(widget) {
  const g = new LinearGradient();
  g.colors = [BG_TOP, BG_MID, new Color("#4A1170"), BG_BOTTOM];
  g.locations = [0, 0.45, 0.8, 1];
  g.startPoint = new Point(0, 0);
  g.endPoint = new Point(1, 1);
  widget.backgroundGradient = g;
}

function glassCard(parent) {
  const card = parent.addStack();
  const sheen = new LinearGradient();
  sheen.colors = [GLASS_SHEEN_TOP, GLASS_SHEEN_MID, GLASS_SHEEN_BOTTOM];
  sheen.locations = [0, 0.35, 1];
  sheen.startPoint = new Point(0, 0);
  sheen.endPoint = new Point(0.6, 1);
  card.backgroundGradient = sheen;
  card.cornerRadius = 20;
  card.borderColor = GLASS_BORDER;
  card.borderWidth = 1;
  card.setPadding(10, 12, 10, 12);
  return card;
}

function cardHeader(card, icon, labelText, tint) {
  const head = card.addStack();
  head.centerAlignContent();
  let img;
  if (typeof icon === "string") {
    const sym = SFSymbol.named(icon);
    img = head.addImage(sym.image);
    img.tintColor = tint;
  } else {
    // A pre-drawn image, already in its final colour
    img = head.addImage(icon);
  }
  img.imageSize = new Size(13, 13);
  head.addSpacer(5);
  const label = head.addText(labelText);
  label.font = Font.semiboldSystemFont(10);
  label.textColor = SUBTLE;
}

// Picks the first symbol that exists on this device.
function pickSymbol(names) {
  for (const n of names) {
    try {
      const s = SFSymbol.named(n);
      if (s && s.image) return n;
    } catch (e) {}
  }
  return names[names.length - 1];
}

// A hand-drawn radiator icon: five rounded bars with heat
// waves above, drawn in the widget's accent colour.
function radiatorIcon(tint) {
  const ctx = new DrawContext();
  ctx.size = new Size(44, 44);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  // Heat waves
  ctx.setStrokeColor(tint);
  ctx.setLineWidth(3);
  const waveXs = [8, 17, 26, 35];
  for (const x of waveXs) {
    const p = new Path();
    p.move(new Point(x, 16));
    p.addCurve(new Point(x, 10.5), new Point(x - 4, 14.5), new Point(x + 4, 12));
    p.addCurve(new Point(x, 4), new Point(x - 4, 9), new Point(x + 4, 6));
    ctx.addPath(p);
    ctx.strokePath();
  }

  // Radiator bars
  ctx.setFillColor(tint);
  for (let i = 0; i < 5; i++) {
    const x = 4 + i * 7.5;
    const bar = new Path();
    bar.addRoundedRect(new Rect(x, 20, 5.5, 21), 2.75, 2.75);
    ctx.addPath(bar);
    ctx.fillPath();
  }

  return ctx.getImage();
}
const HEATING_ICON = radiatorIcon(PINK);

// A simple icon of the Cosy outdoor unit, based on photos:
// a rounded dome-topped body with a round fan grille and a
// pink dot in the centre for the octopus. Drawn, not a copy
// of any logo. bodyColour outlines the unit; dotColour is
// the centre.
function heatPumpIcon(bodyColour, dotColour) {
  const ctx = new DrawContext();
  ctx.size = new Size(44, 44);
  ctx.opaque = false;
  ctx.respectScreenScale = true;

  // Body: rounded dome, wider at the base. Drawn large so it
  // fills the canvas and matches the other header icons.
  ctx.setFillColor(bodyColour);
  const body = new Path();
  body.move(new Point(5, 42));
  body.addLine(new Point(5, 20));
  body.addCurve(new Point(22, 2), new Point(5, 9), new Point(11, 2));
  body.addCurve(new Point(39, 20), new Point(33, 2), new Point(39, 9));
  body.addLine(new Point(39, 42));
  body.addLine(new Point(5, 42));
  ctx.addPath(body);
  ctx.fillPath();

  // Fan grille: dark disc, sized to sit inside the body
  const cx = 22, cy = 20, r = 11;
  ctx.setFillColor(new Color("#10002E"));
  const disc = new Path();
  disc.addEllipse(new Rect(cx - r, cy - r, r * 2, r * 2));
  ctx.addPath(disc);
  ctx.fillPath();

  // A few fan blades as light curved strokes on the dark disc
  ctx.setStrokeColor(bodyColour);
  ctx.setLineWidth(1.5);
  for (let i = 0; i < 3; i++) {
    const a = (i * 2 * Math.PI) / 3;
    const blade = new Path();
    blade.move(new Point(cx, cy));
    blade.addCurve(
      new Point(cx + r * 0.85 * Math.cos(a), cy + r * 0.85 * Math.sin(a)),
      new Point(cx + r * 0.3 * Math.cos(a - 0.6), cy + r * 0.3 * Math.sin(a - 0.6)),
      new Point(cx + r * 0.7 * Math.cos(a - 0.5), cy + r * 0.7 * Math.sin(a - 0.5))
    );
    ctx.addPath(blade);
    ctx.strokePath();
  }

  // Pink centre for the octopus
  ctx.setFillColor(dotColour);
  const dot = new Path();
  dot.addEllipse(new Rect(cx - 4, cy - 4, 8, 8));
  ctx.addPath(dot);
  ctx.fillPath();

  return ctx.getImage();
}

// Droplet icon for humidity, if this iOS version has it
const HUMIDITY_SYMBOL = pickSymbol(["humidity.fill", "drop.fill", ""]);

// Medium widget width by device, from Apple's widget size tables.
// Used to split the row into three equal tiles.
function mediumWidgetWidth() {
  const sw = Device.screenSize().width;
  if (sw >= 428) return 364;
  if (sw >= 414) return 360;
  if (sw >= 393) return 338;
  return 329;
}

// ─────────────────────────────────────────────
// Widget layouts
// ─────────────────────────────────────────────

function buildMediumWidget(r) {
  const w = new ListWidget();
  applyBackground(w);
  w.setPadding(12, 12, 10, 12);

  const tileW = Math.floor((mediumWidgetWidth() - 24 - 16) / 3);
  const blockW = tileW * 3 + 16;

  const titleText = r.model
    ? ("OCTOPUS " + String(r.model)).toUpperCase()
    : "OCTOPUS COSY";
  const titleRow = w.addStack();
  titleRow.layoutHorizontally();
  titleRow.addSpacer();
  const titleCard = titleRow.addStack();
  titleCard.layoutHorizontally();
  titleCard.centerAlignContent();
  titleCard.size = new Size(blockW, 0);
  titleCard.setPadding(0, 12, 2, 12);
  titleCard.addSpacer();
  const title = titleCard.addText(titleText);
  title.font = Font.semiboldSystemFont(9);
  title.textColor = FAINT;
  titleCard.addSpacer();
  titleRow.addSpacer();
  w.addSpacer(6);

  const row = w.addStack();
  row.layoutHorizontally();
  row.addSpacer();

  // ── Tile 1: pump ──
  const pumpCard = glassCard(row);
  pumpCard.layoutVertically();
  pumpCard.size = new Size(tileW, 104);

  const p = r.perf;
  const running = r.waterActive || r.heatActive ||
    (p && p.powerInput !== null && p.powerInput > 0.1);
  const faults = r.faults || [];

  const headerTint = faults.length > 0 ? AMBER : (running ? PINK : CYAN);
  // Icon body is a fixed grey to match the real unit; the
  // state still shows in the word below and the footer dot.
  const pumpIcon = heatPumpIcon(new Color("#B8B8C4"), PINK);
  cardHeader(pumpCard, pumpIcon, "PUMP", headerTint);
  pumpCard.addSpacer();

  let stateText = r.allOff ? "Off" : "Standby";
  let stateColour = r.allOff ? FAINT : TEXT;
  if (faults.length > 0) {
    stateText = "Fault";
    stateColour = AMBER;
  } else if (!r.connected && !running) {
    stateText = "Offline";
    stateColour = FAINT;
  } else if (running) {
    stateText = "Running";
    stateColour = PINK;
  }
  const stateTxt = pumpCard.addText(stateText);
  stateTxt.font = Font.boldRoundedSystemFont(26);
  stateTxt.textColor = stateColour;
  stateTxt.lineLimit = 1;
  stateTxt.minimumScaleFactor = 0.5;

  if (faults.length > 0) {
    const faultLine = pumpCard.addText(faults.slice(0, 2).join(", "));
    faultLine.font = Font.mediumSystemFont(9);
    faultLine.textColor = AMBER;
    faultLine.lineLimit = 1;
    faultLine.minimumScaleFactor = 0.6;
  }

  if (running && p && p.heatOutput !== null) {
    let perfText = (Math.round(p.heatOutput * 10) / 10) + " kW";
    if (p.cop !== null) {
      perfText += " · COP " + (Math.round(p.cop * 10) / 10);
    }
    const perfLine = pumpCard.addText(perfText);
    perfLine.font = Font.mediumSystemFont(9);
    perfLine.textColor = CYAN;
    perfLine.lineLimit = 1;
    perfLine.minimumScaleFactor = 0.7;
  }

  const t = r.today;
  if (t && t.energyIn !== null) {
    let todayText = "Today " + (Math.round(t.energyIn * 10) / 10) + " kWh";
    if (t.cop !== null) {
      todayText += " · COP " + (Math.round(t.cop * 10) / 10);
    }
    const todayLine = pumpCard.addText(todayText);
    todayLine.font = Font.mediumSystemFont(9);
    todayLine.textColor = SUBTLE;
    todayLine.lineLimit = 1;
    todayLine.minimumScaleFactor = 0.6;
  }

  const y = r.yesterday;
  if (y && y.energyIn !== null) {
    let ystText = "Yst " + (Math.round(y.energyIn * 10) / 10) + " kWh";
    if (y.cop !== null) {
      ystText += " · COP " + (Math.round(y.cop * 10) / 10);
    }
    const ystLine = pumpCard.addText(ystText);
    ystLine.font = Font.mediumSystemFont(9);
    ystLine.textColor = FAINT;
    ystLine.lineLimit = 1;
    ystLine.minimumScaleFactor = 0.6;
  }

  pumpCard.addSpacer();

  const outText = (p && p.outdoorTemp !== null)
    ? "Outside " + fmtTemp(p.outdoorTemp)
    : "Outside --°";
  const outLine = pumpCard.addText(outText);
  outLine.font = Font.mediumSystemFont(9);
  outLine.textColor = SUBTLE;
  outLine.lineLimit = 1;
  outLine.minimumScaleFactor = 0.7;

  row.addSpacer(8);

  // ── Tile 2: hot water ──
  const waterCard = glassCard(row);
  waterCard.layoutVertically();
  waterCard.size = new Size(tileW, 104);

  cardHeader(waterCard, "drop.fill", "WATER", CYAN);
  // Fixed top spacer pins the number's height, so it lines up
  // with the heating tile regardless of lines below.
  waterCard.addSpacer(r.waterActive ? 6 : 19);

  if (r.waterActive) {
    const heatingLbl = waterCard.addText("Heating");
    heatingLbl.font = Font.semiboldSystemFont(10);
    heatingLbl.textColor = PINK;
    heatingLbl.lineLimit = 1;
  }

  const bigTemp = waterCard.addText(fmtTemp(r.water ? r.water.temp : null));
  bigTemp.font = Font.boldRoundedSystemFont(26);
  bigTemp.textColor = TEXT;
  bigTemp.lineLimit = 1;

  waterCard.addSpacer();

  // Sub-line shows the water zone mode in one word,
  // to match the other tiles' bottom lines.
  let waterSubText;
  const mode = r.waterMode;
  if (r.water && r.water.online === false) {
    waterSubText = "Sensor offline";
  } else if (mode === "BOOST") {
    waterSubText = "Boosting";
  } else if (mode === "OFF") {
    waterSubText = "Off";
  } else if (mode === "AUTO") {
    waterSubText = "Schedule";
  } else if (mode) {
    waterSubText = "On";
  } else {
    waterSubText = "Cylinder";
  }
  const waterSub = waterCard.addText(waterSubText);
  waterSub.font = Font.mediumSystemFont(9);
  waterSub.textColor = SUBTLE;
  waterSub.lineLimit = 1;
  waterSub.minimumScaleFactor = 0.7;

  row.addSpacer(8);

  // ── Tile 3: pod ──
  const podCard = glassCard(row);
  podCard.layoutVertically();
  podCard.size = new Size(tileW, 104);

  if (r.pods.length === 0) {
    cardHeader(podCard, HEATING_ICON, "HEATING", PINK);
    podCard.addSpacer();
    const phText = podCard.addText("No pods online");
    phText.font = Font.mediumSystemFont(11);
    phText.textColor = TEXT;
    phText.lineLimit = 2;
    phText.minimumScaleFactor = 0.7;
    podCard.addSpacer();
    const phSub = podCard.addText("Auto-detects");
    phSub.font = Font.mediumSystemFont(9);
    phSub.textColor = FAINT;
  } else if (r.pods.length === 1) {
    const pod = r.pods[0];
    cardHeader(podCard, HEATING_ICON, "HEATING", PINK);
    podCard.addSpacer(r.heatActive ? 6 : 19);

    if (r.heatActive) {
      const heatingLbl = podCard.addText("Heating");
      heatingLbl.font = Font.semiboldSystemFont(10);
      heatingLbl.textColor = PINK;
      heatingLbl.lineLimit = 1;
    }

    const podTemp = podCard.addText(fmtTemp(pod.temp));
    podTemp.font = Font.boldRoundedSystemFont(26);
    podTemp.textColor = pod.online === false ? FAINT : TEXT;
    podTemp.lineLimit = 1;

    podCard.addSpacer();

    const subRow = podCard.addStack();
    subRow.centerAlignContent();
    const nameTxt = subRow.addText(pod.name);
    nameTxt.font = Font.mediumSystemFont(9);
    nameTxt.textColor = SUBTLE;
    nameTxt.lineLimit = 1;
    nameTxt.minimumScaleFactor = 0.7;
    if (pod.humidity !== null && pod.humidity !== undefined) {
      const sep = subRow.addText(" · ");
      sep.font = Font.mediumSystemFont(9);
      sep.textColor = SUBTLE;
      if (HUMIDITY_SYMBOL) {
        const dropImg = subRow.addImage(SFSymbol.named(HUMIDITY_SYMBOL).image);
        dropImg.imageSize = new Size(9, 9);
        dropImg.tintColor = CYAN;
        subRow.addSpacer(2);
      }
      const hum = subRow.addText(Math.round(pod.humidity) + "%");
      hum.font = Font.mediumSystemFont(9);
      hum.textColor = SUBTLE;
    } else if (pod.online === false) {
      const off = subRow.addText(" · Offline");
      off.font = Font.mediumSystemFont(9);
      off.textColor = SUBTLE;
    }
  } else {
    // Two to four pods: show the average big, with a
    // summary line of the count, range and average humidity.
    const temps = r.pods
      .map(p => p.temp)
      .filter(t => t !== null && t !== undefined);
    const avg = temps.reduce((a, b) => a + b, 0) / temps.length;
    const lo = Math.min(...temps);
    const hi = Math.max(...temps);

    const hums = r.pods
      .map(p => p.humidity)
      .filter(h => h !== null && h !== undefined);
    const avgHum = hums.length
      ? Math.round(hums.reduce((a, b) => a + b, 0) / hums.length)
      : null;

    cardHeader(podCard, HEATING_ICON, "HEATING", PINK);
    // Same fixed top spacer as the water tile, so the numbers
    // sit at the same height.
    podCard.addSpacer(r.heatActive ? 6 : 19);
    if (r.heatActive) {
      const heatingLbl = podCard.addText("Heating");
      heatingLbl.font = Font.semiboldSystemFont(10);
      heatingLbl.textColor = PINK;
      heatingLbl.lineLimit = 1;
    }

    const avgTemp = podCard.addText(fmtTemp(avg));
    avgTemp.font = Font.boldRoundedSystemFont(26);
    avgTemp.textColor = TEXT;
    avgTemp.lineLimit = 1;

    // Range sits directly under the average
    const line1 = podCard.addText(
      r.pods.length + " pods · " + fmtTemp(lo) + "–" + fmtTemp(hi)
    );
    line1.font = Font.mediumSystemFont(9);
    line1.textColor = SUBTLE;
    line1.lineLimit = 1;
    line1.minimumScaleFactor = 0.6;

    podCard.addSpacer();

    // Average humidity across all pods, on the bottom line
    if (avgHum !== null) {
      const humRow = podCard.addStack();
      humRow.centerAlignContent();
      if (HUMIDITY_SYMBOL) {
        const dropImg = humRow.addImage(SFSymbol.named(HUMIDITY_SYMBOL).image);
        dropImg.imageSize = new Size(9, 9);
        dropImg.tintColor = CYAN;
        humRow.addSpacer(2);
      }
      const humTxt = humRow.addText(avgHum + "% avg");
      humTxt.font = Font.mediumSystemFont(9);
      humTxt.textColor = SUBTLE;
      humTxt.lineLimit = 1;
      humTxt.minimumScaleFactor = 0.6;
    }
  }
  row.addSpacer();

  // ── Footer ──
  w.addSpacer(6);
  const footer = w.addStack();
  footer.centerAlignContent();
  footer.addSpacer(6);
  const s = statusLine(r);
  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  const dot = footer.addText("●");
  dot.font = Font.systemFont(6);
  footer.addSpacer(5);
  let footerText;
  if (r.stale) {
    // Showing saved data; the fetch didn't get through
    dot.textColor = YELLOW;
    const when = r.savedAt ? new Date(r.savedAt) : new Date();
    footerText = "Last data " + df.string(when);
  } else {
    dot.textColor = s.colour;
    footerText = "Updated " + df.string(new Date());
  }
  const updated = footer.addText(footerText);
  updated.font = Font.regularSystemFont(9);
  updated.textColor = FAINT;
  footer.addSpacer();

  return w;
}

function buildSmallWidget(r) {
  const w = new ListWidget();
  applyBackground(w);
  w.setPadding(14, 14, 14, 14);

  cardHeader(w, "drop.fill", "HOT WATER", CYAN);
  w.addSpacer();

  const bigTemp = w.addText(fmtTemp(r.water ? r.water.temp : null));
  bigTemp.font = Font.boldRoundedSystemFont(42);
  bigTemp.textColor = TEXT;
  bigTemp.minimumScaleFactor = 0.6;

  if (r.pods.length > 0) {
    const pod = r.pods[0];
    const podLine = w.addText(
      pod.name + " " + fmtTemp(pod.temp)
    );
    podLine.font = Font.mediumSystemFont(11);
    podLine.textColor = SUBTLE;
  }

  w.addSpacer();

  const df = new DateFormatter();
  df.dateFormat = "HH:mm";
  let smallFooter;
  if (r.stale) {
    const when = r.savedAt ? new Date(r.savedAt) : new Date();
    smallFooter = "Last data " + df.string(when);
  } else {
    smallFooter = statusLine(r).text + " · " + df.string(new Date());
  }
  const updated = w.addText(smallFooter);
  updated.font = Font.regularSystemFont(9);
  updated.textColor = FAINT;

  return w;
}

function buildErrorWidget(message) {
  const w = new ListWidget();
  applyBackground(w);
  w.setPadding(14, 14, 14, 14);

  cardHeader(w, "exclamationmark.triangle.fill", "COSY WIDGET", PINK);
  w.addSpacer(8);
  const msg = w.addText(message);
  msg.font = Font.mediumSystemFont(11);
  msg.textColor = TEXT;
  msg.minimumScaleFactor = 0.7;

  return w;
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

// Saves the readings we can safely restore later. Times and
// live perf are kept, but we store the fetch time so a stale
// render can show "Last data HH:MM".
const SAVED_READINGS_KEY = "cosy-widget-last-readings";

function saveReadings(readings) {
  try {
    const toSave = {
      savedAt: new Date().toISOString(),
      water: readings.water,
      waterSetpoint: readings.waterSetpoint,
      waterMode: readings.waterMode,
      pods: readings.pods,
      connected: readings.connected,
      waterActive: readings.waterActive,
      heatActive: readings.heatActive,
      allOff: readings.allOff,
      faults: readings.faults,
      model: readings.model,
      perf: readings.perf,
      today: readings.today,
      yesterday: readings.yesterday
    };
    Keychain.set(SAVED_READINGS_KEY, JSON.stringify(toSave));
  } catch (e) {
    // Saving is best-effort; ignore failures
  }
}

function loadReadings() {
  try {
    if (!Keychain.contains(SAVED_READINGS_KEY)) return null;
    return JSON.parse(Keychain.get(SAVED_READINGS_KEY));
  } catch (e) {
    return null;
  }
}

let widget;

// No key yet: always show the setup message. Never fall back
// to saved data here, so a fresh install shows instructions.
if (API_KEY.includes("PASTE_YOUR")) {
  widget = buildErrorWidget(
    "Add your Octopus API key at the top of the script. " +
    "Find it at octopus.energy → Account → API access."
  );
} else {
  try {
    const token = await getToken();
    const ids = await discoverIds(token);

    const nowDate = new Date();
    const midnight = new Date(
      nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate()
    );
    const prevMidnight = new Date(midnight.getTime() - 24 * 60 * 60 * 1000);

    // These five calls don't depend on each other, so they run
    // at the same time. Only the status call is essential; the
    // others fall back to null and the widget carries on.
    const [configInfo, status, perf, today, yesterday] = await Promise.all([
      getConfigInfo(token, ids)
        .catch(() => ({ faults: [], waterSensor: null, model: null })),
      getControllerStatus(token, ids),
      getLivePerformance(token, ids).catch(() => null),
      getRangedPerformance(token, ids, midnight, nowDate).catch(() => null),
      getYesterdayCached(token, ids, prevMidnight, midnight).catch(() => null)
    ]);

    const readings = parseReadings(status, configInfo.waterSensor);
    readings.faults = configInfo.faults;
    readings.model = configInfo.model;
    readings.perf = perf;
    readings.today = today;
    readings.yesterday = yesterday;

    if (TEST_FAULT && readings.faults.length === 0) {
      readings.faults = ["F-TEST"];
    }
    if (TEST_PODS) {
      // Made-up readings to preview the four-pod layout
      readings.pods = [
        { name: podName(1), temp: 21.4, humidity: 52, online: true },
        { name: podName(2), temp: 19.8, humidity: 55, online: true },
        { name: podName(3), temp: 22.1, humidity: 49, online: true },
        { name: podName(4), temp: 20.3, humidity: 57, online: true }
      ];
    }
    if (TEST_WATER_HEATING) {
      readings.waterActive = true;
    }
    if (TEST_CENTRAL_HEATING) {
      readings.heatActive = true;
    }

    // Fresh data: save it and mark it current.
    readings.stale = false;
    saveReadings(readings);

    widget = (config.widgetFamily === "small")
      ? buildSmallWidget(readings)
      : buildMediumWidget(readings);
  } catch (err) {
    console.error(err);
    // A real fetch failed or timed out. Fall back to the last
    // saved readings if we have them, marked stale. Only show
    // the error widget if there's nothing saved at all.
    const saved = loadReadings();
    if (saved) {
      saved.stale = true;
      widget = (config.widgetFamily === "small")
        ? buildSmallWidget(saved)
        : buildMediumWidget(saved);
    } else {
      widget = buildErrorWidget(String(err.message || err));
    }
  }
}

widget.refreshAfterDate = new Date(Date.now() + REFRESH_MINUTES * 60 * 1000);
if (TAP_URL) widget.url = TAP_URL;

if (config.runsInWidget) {
  Script.setWidget(widget);
} else {
  await widget.presentMedium();
}
Script.complete();

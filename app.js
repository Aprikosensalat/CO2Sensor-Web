"use strict";

// Muessen zu den UUIDs in src/main.cpp der Firmware passen.
const SERVICE_UUID = "c02a0000-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_LIVE_UUID = "c02a0001-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_STATUS_UUID = "c02a0002-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_CONTROL_UUID = "c02a0003-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_LOG_DATA_UUID = "c02a0004-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_SEGMENTS_UUID = "c02a0007-5c3b-4d2a-9f1e-8b4c2d6e0a02";
const CHAR_CONFIG_UUID = "c02a0008-5c3b-4d2a-9f1e-8b4c2d6e0a02";

const CMD_SET_TIME = 1;
const CMD_SET_INTERVAL = 2;
const CMD_LOG_CLEAR = 3;
const CMD_DOWNLOAD = 4;
const CMD_DOWNLOAD_CANCEL = 5;
const CMD_SEGMENTS = 10;
const CMD_FRC = 20;
const CMD_ASC = 21;
const CMD_TEMP_OFFSET = 22;
const CMD_ALTITUDE = 23;
const CMD_DISPLAY_ON = 24;
const CMD_DISPLAY_CONTRAST = 25;

const FLAG_TIME_SET = 1 << 0;
const FLAG_SENSOR_OK = 1 << 1;
const CONFIG_ASC = 1 << 0;
const CONFIG_DISPLAY_ON = 1 << 1;
const CONFIG_VALID = 1 << 2;

const NO_CO2 = 0xffff;
const NO_TEMP = -32768;
const NO_HUM = 0xffff;
const RECORD_SIZE = 16;
const SEGMENT_RECORDS = 4096;
const SEGMENTS_TIMEOUT_MS = 5000;
const SYNC_STALL_MS = 2000;
const AUTO_REFRESH_MS = 60000;

// Bewertung wie auf dem Display
const CO2_GOOD = 800;
const CO2_MEDIUM = 1000;
const CO2_BAD = 1400;

// Einstellungen im localStorage, Logdaten in IndexedDB
const SERIES_STORAGE_KEY = "co2sensor-hidden-series";
const RANGE_STORAGE_KEY = "co2sensor-range";
const TAB_STORAGE_KEY = "co2sensor-tab";
const ZOOM_STORAGE_KEY = "co2sensor-zoom";
const DB_NAME = "co2sensor";
const DB_STORE = "records";
const LOCAL_SAVE_BATCH = 500;

// Die drei Messgroessen. Je Groesse ein Diagramm.
const SERIES = [
  { key: "co2", label: "CO₂", unit: "ppm", digits: 0, csvDigits: 0, color: "--s1", minSpan: 100 },
  { key: "temp", label: "Temperatur", unit: "°C", digits: 1, csvDigits: 2, color: "--s0", minSpan: 1 },
  { key: "hum", label: "Luftfeuchte", unit: "%", digits: 0, csvDigits: 1, color: "--s5", minSpan: 5 },
  // Aus Temperatur und Luftfeuchte berechnet
  { key: "dew", label: "Taupunkt", unit: "°C", digits: 1, csvDigits: 1, color: "--s3", minSpan: 1 },
  { key: "abs", label: "Absolute Feuchte", unit: "g/m³", digits: 1, csvDigits: 2, color: "--s2", minSpan: 1 },
];

const el = (id) => document.getElementById(id);

const ui = {
  connect: el("connect"),
  message: el("message"),
  connection: el("connection"),
  live: el("live"),
  range: el("range"),
  refresh: el("refresh"),
  download: el("download"),
  seriesToggles: el("seriesToggles"),
  progress: el("progress"),
  history: el("history"),
  chartList: el("chartList"),
  localInfo: el("localInfo"),
  clearLocal: el("clearLocal"),
  archive: el("archive"),
  archiveProgress: el("archiveProgress"),
  archiveStatus: el("archiveStatus"),
  calendar: el("calendar"),
  calPrev: el("calPrev"),
  calNext: el("calNext"),
  calTitle: el("calTitle"),
  calGrid: el("calGrid"),
  dayPrev: el("dayPrev"),
  dayToday: el("dayToday"),
  dayNext: el("dayNext"),
  zoomControls: el("zoomControls"),
  zoom: el("zoom"),
  panPrev: el("panPrev"),
  panNext: el("panNext"),
  zoomRange: el("zoomRange"),
  interval: el("interval"),
  storage: el("storage"),
  clear: el("clear"),
  sensorInfo: el("sensorInfo"),
  asc: el("asc"),
  frcPpm: el("frcPpm"),
  frc: el("frc"),
  tempOffset: el("tempOffset"),
  saveTempOffset: el("saveTempOffset"),
  altitude: el("altitude"),
  saveAltitude: el("saveAltitude"),
  displayOn: el("displayOn"),
  contrast: el("contrast"),
  tabs: document.querySelectorAll("[data-tab]"),
  pages: document.querySelectorAll("[data-page]"),
};

let device = null;
let controlChar = null;
let status = null;
let live = null;      // {co2, temp, hum}, null = kein Wert
let config = null;    // {asc, displayOn, valid, tempOffset, altitude, contrast}
let records = [];
let nextRecord = 0;
let syncing = false;
let resumePending = false;
let lastSyncData = 0;
let writeChain = Promise.resolve();
let hoverEpoch = null;
let visibleSeries = SERIES.map((s) => s.key);
let chartViews = [];  // [{series, canvas, tooltip}]

// Logdaten im Browser (IndexedDB)
let recordsFromBrowser = false;
let pendingLocal = [];
let localDays = new Set();
let localFirstDay = null;
let localLoadToken = 0;
// Ganzes Log in den Browser laden: {start, next, stored, noTime, startedMs, lastData, resumePending}
let archive = null;

// Kalender: Zeitindex der Segmente und gewaehlter Tag
let segments = [];    // [{segment, epoch}], epoch 0 = unbekannt
let segmentsBuffer = [];
let segmentsResolve = null;
let selectedDay = startOfDay(new Date());
let calendarMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
let dayStartIndex = 0;
let dayEndIndex = 0;
let viewEnd = null;   // Ende des Ausschnitts, null = am Ende (jetzt bzw. Tagesende)

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

function sameDay(a, b) {
  return a.getTime() === startOfDay(b).getTime();
}

function dayMode() {
  return ui.range.value === "day";
}

// Beginn und Ende des gewaehlten Tages in Unix-Zeit (Ortszeit, auch bei Zeitumstellung)
function dayBounds() {
  return [
    Math.floor(selectedDay.getTime() / 1000),
    Math.floor(addDays(selectedDay, 1).getTime() / 1000),
  ];
}

function showMessage(text) {
  ui.message.textContent = text;
  ui.message.hidden = !text;
}

function isConnected() {
  return Boolean(device && device.gatt.connected && controlChar);
}

function formatNumber(value, digits) {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function seriesColor(series) {
  return cssVar(series.color);
}

function co2Rating(co2) {
  if (co2 < CO2_GOOD) return { text: "Gut", level: "good" };
  if (co2 < CO2_MEDIUM) return { text: "Mittel", level: "medium" };
  if (co2 < CO2_BAD) return { text: "Lüften empfohlen", level: "high" };
  return { text: "Schlecht, bitte lüften", level: "bad" };
}

function ratingColor(level) {
  return cssVar(`--co2-${level}`);
}

// Web Bluetooth erlaubt nur eine GATT-Operation gleichzeitig.
function enqueue(operation) {
  writeChain = writeChain.catch(() => {}).then(operation);
  return writeChain;
}

function sendCommand(op, arg = 0) {
  const data = new DataView(new ArrayBuffer(5));
  data.setUint8(0, op);
  data.setUint32(1, arg >>> 0, true);
  return enqueue(() => controlChar.writeValueWithResponse(data.buffer));
}

// --- Verbindung ---------------------------------------------------------

async function connect() {
  showMessage("");
  try {
    device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }],
    });
    device.addEventListener("gattserverdisconnected", onDisconnected);
    ui.connection.textContent = "Verbinde …";

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const liveChar = await service.getCharacteristic(CHAR_LIVE_UUID);
    const statusChar = await service.getCharacteristic(CHAR_STATUS_UUID);
    const logDataChar = await service.getCharacteristic(CHAR_LOG_DATA_UUID);
    const segmentsChar = await service.getCharacteristic(CHAR_SEGMENTS_UUID);
    const configChar = await service.getCharacteristic(CHAR_CONFIG_UUID);
    controlChar = await service.getCharacteristic(CHAR_CONTROL_UUID);

    liveChar.addEventListener("characteristicvaluechanged", (event) => onLive(event.target.value));
    statusChar.addEventListener("characteristicvaluechanged", (event) => onStatus(event.target.value));
    logDataChar.addEventListener("characteristicvaluechanged", (event) => onLogData(event.target.value));
    segmentsChar.addEventListener("characteristicvaluechanged", (event) => onSegments(event.target.value));
    configChar.addEventListener("characteristicvaluechanged", (event) => onConfig(event.target.value));
    await liveChar.startNotifications();
    await statusChar.startNotifications();
    await logDataChar.startNotifications();
    await segmentsChar.startNotifications();
    await configChar.startNotifications();

    // Korrigiert auch alle Daten, die seit dem Start ohne Uhrzeit geloggt wurden.
    await sendCommand(CMD_SET_TIME, Math.floor(Date.now() / 1000));
    onLive(await liveChar.readValue());
    onStatus(await statusChar.readValue());
    onConfig(await configChar.readValue());

    ui.connection.textContent = `Verbunden mit ${device.name || "ESP32"}`;
    ui.connect.textContent = "Trennen";
    if (dayMode()) {
      await loadDay();
    } else {
      await fetchSegments();  // fuer den Datumsbereich des Kalenders
      resetRecords();
      await startSync();
    }
  } catch (error) {
    if (error.name !== "NotFoundError") {
      showMessage(`Verbindung fehlgeschlagen: ${error.message}`);
    }
    if (device && device.gatt.connected) {
      device.gatt.disconnect();
    } else {
      onDisconnected();
    }
  }
}

function onDisconnected() {
  controlChar = null;
  status = null;
  live = null;
  config = null;
  syncing = false;
  resumePending = false;
  ui.progress.hidden = true;
  ui.connection.textContent = "Nicht verbunden";
  ui.connect.textContent = "Verbinden";
  ui.storage.textContent = "Speicher: –";
  if (archive) {
    finishArchive(false, ", weil die Verbindung getrennt wurde");
  }
  flushLocal();
  renderLive();
  renderConfig();
  renderHistory();
}

// --- Eingehende Daten ---------------------------------------------------

// Taupunkt nach der Magnus-Formel in Grad, wie auf dem Display
function dewPoint(temp, hum) {
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(hum / 100) + (a * temp) / (b + temp);
  return (b * gamma) / (a - gamma);
}

// Absolute Feuchte in g/m³
function absoluteHumidity(temp, hum) {
  const saturation = 6.112 * Math.exp((17.62 * temp) / (243.12 + temp));  // hPa
  return (216.7 * (hum / 100) * saturation) / (273.15 + temp);
}

// Ergaenzt Taupunkt und absolute Feuchte, die der ESP32 nicht sendet.
function withDerived(values) {
  const ok = values.temp !== null && values.hum !== null && values.hum > 0;
  values.dew = ok ? dewPoint(values.temp, values.hum) : null;
  values.abs = ok ? absoluteHumidity(values.temp, values.hum) : null;
  return values;
}

// u16 CO2 in ppm, i16 Temperatur in 1/100 Grad, u16 Luftfeuchte in 1/100 %
function readValues(view, offset) {
  const co2 = view.getUint16(offset, true);
  const temp = view.getInt16(offset + 2, true);
  const hum = view.getUint16(offset + 4, true);
  return withDerived({
    co2: co2 === NO_CO2 ? null : co2,
    temp: temp === NO_TEMP ? null : temp / 100,
    hum: hum === NO_HUM ? null : hum / 100,
  });
}

function onLive(view) {
  live = view.byteLength >= 6 ? readValues(view, 0) : null;
  renderLive();
}

function onConfig(view) {
  if (view.byteLength < 6) {
    return;
  }
  const flags = view.getUint8(0);
  config = {
    asc: Boolean(flags & CONFIG_ASC),
    displayOn: Boolean(flags & CONFIG_DISPLAY_ON),
    valid: Boolean(flags & CONFIG_VALID),
    tempOffset: view.getUint16(1, true) / 100,
    altitude: view.getUint16(3, true),
    contrast: view.getUint8(5),
  };
  renderConfig();
}

function onStatus(view) {
  const flags = view.getUint8(0);
  status = {
    timeSet: Boolean(flags & FLAG_TIME_SET),
    sensorOk: Boolean(flags & FLAG_SENSOR_OK),
    oldestIndex: view.getUint32(1, true),
    nextIndex: view.getUint32(5, true),
    capacity: view.getUint32(9, true),
    intervalS: view.getUint32(13, true),
  };

  // Das Log wurde auf dem Geraet geloescht.
  if (status.nextIndex < nextRecord) {
    if (dayMode()) {
      records = [];
      nextRecord = status.oldestIndex;
    } else {
      resetRecords();
    }
    renderHistory();
  }

  const stored = status.nextIndex - status.oldestIndex;
  const percent = status.capacity ? formatNumber((stored / status.capacity) * 100, 1) : "0";
  const days = (status.capacity * status.intervalS) / 86400;
  ui.storage.textContent =
    `Speicher: ${stored.toLocaleString("de-DE")} von ` +
    `${status.capacity.toLocaleString("de-DE")} Datensätzen (${percent} %), ` +
    `reicht bei diesem Intervall für etwa ${formatNumber(days, 0)} Tage`;

  if (isConnected()) {
    ui.connection.textContent =
      `Verbunden mit ${device.name || "ESP32"}` + (status.sensorOk ? "" : " – SCD30 liefert keine Werte");
  }

  if (document.activeElement !== ui.interval) {
    const value = String(status.intervalS);
    if (![...ui.interval.options].some((option) => option.value === value)) {
      ui.interval.add(new Option(`${value} s`, value));
    }
    ui.interval.value = value;
  }
  renderLive();
  updateControls();
}

function onLogData(view) {
  if (archive) {
    onArchiveData(view);
    return;
  }
  // Nach einem Abbruch koennen noch Pakete unterwegs sein.
  if (!syncing) {
    return;
  }
  const first = view.getUint32(0, true);
  const count = Math.floor((view.byteLength - 4) / RECORD_SIZE);
  lastSyncData = Date.now();

  // Alte Daten wurden auf dem Geraet ueberschrieben: an der neuen Grenze weitermachen.
  if (status && nextRecord < status.oldestIndex && first >= status.oldestIndex) {
    nextRecord = first;
  }

  if (first !== nextRecord) {
    requestResume();
    return;
  }
  resumePending = false;

  if (count === 0) {
    finishSync();
    return;
  }

  // Im Kalender nur Datensaetze des gewaehlten Tages behalten. Ist das Ende des
  // Tages erreicht, wird der Download abgebrochen.
  const [dayStart, dayEnd] = dayBounds();
  let reachedEnd = false;
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * RECORD_SIZE;
    const epoch = view.getUint32(offset, true);
    if (dayMode()) {
      if (epoch >= dayEnd) {
        reachedEnd = true;
        break;
      }
      if (epoch < dayStart) {
        continue;  // davor oder ohne Uhrzeit
      }
    }
    const record = {
      index: first + i,
      epoch,
      uptimeS: view.getUint32(offset + 4, true),
      ...readValues(view, offset + 8),
    };
    records.push(record);
    if (epoch > 0) {
      pendingLocal.push(record);
    }
  }
  nextRecord = first + count;
  if (pendingLocal.length >= LOCAL_SAVE_BATCH) {
    flushLocal();
  }

  if (reachedEnd) {
    sendCommand(CMD_DOWNLOAD_CANCEL).catch(() => {});
    finishSync();
    return;
  }

  const startIndex = rangeStartIndex();
  const endIndex = dayMode() ? dayEndIndex : status ? status.nextIndex : 0;
  if (endIndex > startIndex) {
    ui.progress.max = endIndex - startIndex;
    ui.progress.value = Math.max(0, nextRecord - startIndex);
  }
  ui.history.textContent = `Lade Log: ${records.length.toLocaleString("de-DE")} Datensätze`;
}

// Zeitindex: u32 erstes Segment, u16 Anzahl, danach je Segment u32 Unix-Zeit.
// Ein Paket mit Anzahl 0 beendet die Liste.
function onSegments(view) {
  const first = view.getUint32(0, true);
  const count = view.getUint16(4, true);
  if (count === 0) {
    segments = segmentsBuffer;
    segmentsBuffer = [];
    renderCalendar();
    if (segmentsResolve) {
      segmentsResolve();
    }
    return;
  }
  for (let i = 0; i < count && 6 + i * 4 + 4 <= view.byteLength; i++) {
    segmentsBuffer.push({ segment: first + i, epoch: view.getUint32(6 + i * 4, true) });
  }
}

function fetchSegments() {
  segmentsBuffer = [];
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      segmentsResolve = null;
      resolve();
    };
    const timer = setTimeout(done, SEGMENTS_TIMEOUT_MS);
    segmentsResolve = done;
    sendCommand(CMD_SEGMENTS).catch(done);
  });
}

// Erster Tag mit Daten auf dem ESP32 oder im Browser, null = nicht begrenzen
function firstDataDay() {
  // Hat das aelteste Segment keine Uhrzeit, koennen spaetere Datensaetze darin
  // trotzdem eine haben. Dann den Kalender nicht nach vorne begrenzen.
  if (segments.length > 0 && segments[0].epoch === 0) {
    return null;
  }
  const days = [];
  if (segments.length > 0) {
    days.push(startOfDay(new Date(segments[0].epoch * 1000)));
  }
  if (localFirstDay) {
    days.push(localFirstDay);
  }
  return days.length ? new Date(Math.min(...days)) : null;
}

// --- Log-Abgleich -------------------------------------------------------

// Erster Index fuer den gewaehlten Zeitraum, geschaetzt ueber das aktuelle Intervall.
function rangeStartIndex() {
  if (!status) {
    return 0;
  }
  if (dayMode()) {
    return dayStartIndex;
  }
  const days = Number(ui.range.value);
  if (days === 0) {
    return status.oldestIndex;
  }
  const wanted = Math.ceil((days * 86400) / Math.max(1, status.intervalS));
  return Math.max(status.oldestIndex, status.nextIndex - wanted);
}

function resetRecords() {
  records = [];
  recordsFromBrowser = false;
  nextRecord = rangeStartIndex();
}

async function startSync() {
  if (syncing || archive || !isConnected()) {
    return;
  }
  syncing = true;
  resumePending = false;
  lastSyncData = Date.now();
  ui.progress.hidden = false;
  updateControls();
  try {
    await sendCommand(CMD_DOWNLOAD, nextRecord);
  } catch (error) {
    syncing = false;
    ui.progress.hidden = true;
    showMessage(`Log konnte nicht geladen werden: ${error.message}`);
    updateControls();
  }
}

function requestResume() {
  if (resumePending || !isConnected()) {
    return;
  }
  resumePending = true;
  sendCommand(CMD_DOWNLOAD, nextRecord).catch(() => {
    resumePending = false;
  });
}

function finishSync() {
  syncing = false;
  ui.progress.hidden = true;
  if (status) {
    records = records.filter((record) => record.index >= status.oldestIndex);
  }
  flushLocal();
  updateControls();
  renderHistory();
}

setInterval(() => {
  if (syncing && Date.now() - lastSyncData > SYNC_STALL_MS) {
    lastSyncData = Date.now();
    resumePending = false;
    requestResume();
  }
  if (archive && Date.now() - archive.lastData > SYNC_STALL_MS) {
    archive.lastData = Date.now();
    archive.resumePending = false;
    requestArchiveResume();
  }
}, 1000);

// --- Ganzes Log in den Browser laden --------------------------------------

async function startArchive() {
  if (!isConnected() || !status || archive) {
    return;
  }
  if (syncing) {
    syncing = false;
    ui.progress.hidden = true;
    await sendCommand(CMD_DOWNLOAD_CANCEL);
  }
  archive = {
    start: status.oldestIndex,
    next: status.oldestIndex,
    stored: 0,
    noTime: 0,
    startedMs: Date.now(),
    lastData: Date.now(),
    resumePending: false,
  };
  showMessage("");
  updateArchiveUi();
  updateControls();
  await sendCommand(CMD_DOWNLOAD, archive.next);
}

function requestArchiveResume() {
  if (!archive || archive.resumePending || !isConnected()) {
    return;
  }
  archive.resumePending = true;
  sendCommand(CMD_DOWNLOAD, archive.next).catch(() => {
    if (archive) {
      archive.resumePending = false;
    }
  });
}

// Wie onLogData, aber alles geht nur in den Browser-Speicher.
function onArchiveData(view) {
  const first = view.getUint32(0, true);
  const count = Math.floor((view.byteLength - 4) / RECORD_SIZE);
  archive.lastData = Date.now();

  if (status && archive.next < status.oldestIndex && first >= status.oldestIndex) {
    archive.next = first;
  }
  if (first !== archive.next) {
    requestArchiveResume();
    return;
  }
  archive.resumePending = false;

  if (count === 0) {
    finishArchive(true);
    return;
  }
  for (let i = 0; i < count; i++) {
    const offset = 4 + i * RECORD_SIZE;
    const epoch = view.getUint32(offset, true);
    if (epoch === 0) {
      archive.noTime++;
      continue;
    }
    pendingLocal.push({
      epoch,
      uptimeS: view.getUint32(offset + 4, true),
      ...readValues(view, offset + 8),
    });
    archive.stored++;
  }
  archive.next = first + count;
  if (pendingLocal.length >= LOCAL_SAVE_BATCH) {
    flushLocal(false);  // Anzeige erst am Ende auffrischen, getAllKeys ist teuer
  }
  updateArchiveUi();
}

async function finishArchive(complete, reason = "") {
  const done = archive;
  archive = null;
  await flushLocal();
  let text = complete
    ? `Fertig: ${done.stored.toLocaleString("de-DE")} Datensätze vom ESP32 im Browser gespeichert.`
    : `Abgebrochen${reason}. ${done.stored.toLocaleString("de-DE")} Datensätze sind bis dahin gespeichert.`;
  if (done.noTime > 0) {
    text += ` ${done.noTime.toLocaleString("de-DE")} Datensätze ohne Uhrzeit wurden übersprungen.`;
  }
  showMessage(text);
  updateArchiveUi();
  updateControls();
  // Die laufende Ansicht wurde fuer den Download unterbrochen, jetzt neu laden.
  if (isConnected() && status) {
    if (dayMode()) {
      await loadDay();
    } else {
      resetRecords();
      renderHistory();
      await startSync();
    }
  }
}

async function cancelArchive() {
  if (!archive) {
    return;
  }
  await sendCommand(CMD_DOWNLOAD_CANCEL).catch(() => {});
  await finishArchive(false);
}

function updateArchiveUi() {
  ui.archive.textContent = archive ? "Abbrechen" : "Alles vom ESP32 in den Browser laden";
  ui.archive.classList.toggle("danger", Boolean(archive));
  ui.archiveProgress.hidden = !archive;
  ui.archiveStatus.hidden = !archive;
  if (!archive) {
    return;
  }
  const end = status ? status.nextIndex : archive.next;
  const total = Math.max(1, end - archive.start);
  const done = Math.max(0, archive.next - archive.start);
  ui.archiveProgress.max = total;
  ui.archiveProgress.value = done;
  let text = `${done.toLocaleString("de-DE")} von ${total.toLocaleString("de-DE")} Datensätzen geladen`;
  const elapsed = (Date.now() - archive.startedMs) / 1000;
  if (done > 0 && elapsed > 3) {
    const rest = ((total - done) * elapsed) / done;
    text += rest >= 90 ? `, noch etwa ${Math.ceil(rest / 60)} min` : `, noch etwa ${Math.ceil(rest)} s`;
  }
  ui.archiveStatus.textContent = text;
}

// Neue Messungen nachladen. Im Kalender nur, wenn der heutige Tag gewaehlt ist.
setInterval(() => {
  if (isConnected() && (!dayMode() || sameDay(selectedDay, new Date()))) {
    startSync();
  }
}, AUTO_REFRESH_MS);

// --- Kalender -----------------------------------------------------------

// Laedt den gewaehlten Tag. Der Zeitindex der Segmente zeigt, ab welchem
// Datensatz der Tag beginnen kann. Geladen wird von dort bis zum Tagesende.
async function loadDay() {
  renderCalendar();
  if (!isConnected() || !status) {
    await loadLocal();
    return;
  }
  if (archive) {
    return;
  }
  if (syncing) {
    syncing = false;
    await sendCommand(CMD_DOWNLOAD_CANCEL);
  }
  await fetchSegments();

  const [dayStart, dayEnd] = dayBounds();
  let startSegment = segments.length ? segments[0].segment : 0;
  let endIndex = status.nextIndex;
  for (const s of segments) {
    if (s.epoch > 0 && s.epoch <= dayStart) {
      startSegment = s.segment;
    }
    if (s.epoch >= dayEnd) {
      endIndex = s.segment * SEGMENT_RECORDS;
      break;
    }
  }
  dayStartIndex = Math.max(status.oldestIndex, startSegment * SEGMENT_RECORDS);
  dayEndIndex = Math.max(dayStartIndex, endIndex);

  records = [];
  recordsFromBrowser = false;
  nextRecord = dayStartIndex;
  hoverEpoch = null;
  viewEnd = null;
  renderHistory();
  await startSync();
}

function selectDay(date) {
  const today = startOfDay(new Date());
  selectedDay = startOfDay(date > today ? today : date);
  viewEnd = null;
  calendarMonth = new Date(selectedDay.getFullYear(), selectedDay.getMonth(), 1);
  run(loadDay);
}

function renderCalendar() {
  ui.calendar.hidden = !dayMode();
  if (!dayMode()) {
    return;
  }
  const today = startOfDay(new Date());
  const minDay = firstDataDay();
  const year = calendarMonth.getFullYear();
  const month = calendarMonth.getMonth();

  ui.calTitle.textContent = calendarMonth.toLocaleDateString("de-DE", { month: "long", year: "numeric" });
  ui.calGrid.replaceChildren();
  for (const name of ["Mo", "Di", "Mi", "Do", "Fr", "Sa", "So"]) {
    const head = document.createElement("span");
    head.className = "weekday";
    head.textContent = name;
    ui.calGrid.append(head);
  }
  // Montag ist der erste Tag der Woche
  const offset = (new Date(year, month, 1).getDay() + 6) % 7;
  for (let i = 0; i < offset; i++) {
    ui.calGrid.append(document.createElement("span"));
  }
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month, d);
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(d);
    button.disabled = date > today || (minDay !== null && date < minDay);
    if (localDays.has(date.getTime())) {
      button.classList.add("has-data");
      button.title = "Daten im Browser gespeichert";
    }
    if (date.getTime() === selectedDay.getTime()) {
      button.classList.add("selected");
    }
    if (date.getTime() === today.getTime()) {
      button.classList.add("today");
    }
    button.addEventListener("click", () => selectDay(date));
    ui.calGrid.append(button);
  }

  ui.calPrev.disabled = minDay !== null && calendarMonth <= new Date(minDay.getFullYear(), minDay.getMonth(), 1);
  ui.calNext.disabled = new Date(year, month + 1, 1) > today;
  ui.dayPrev.disabled = minDay !== null && selectedDay <= minDay;
  ui.dayNext.disabled = selectedDay >= today;
  ui.dayToday.disabled = selectedDay.getTime() === today.getTime();
}

// --- Aktuelle Werte -----------------------------------------------------

function renderLive() {
  ui.live.replaceChildren();
  if (!isConnected()) {
    return;
  }
  const ok = live && live.co2 !== null;
  for (const series of SERIES) {
    const value = ok ? live[series.key] : null;
    const tile = document.createElement("div");
    tile.className = value === null ? "value missing" : "value";
    let color = seriesColor(series);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = series.label;

    const number = document.createElement("span");
    number.className = "number";
    const note = document.createElement("span");
    note.className = "address";
    if (value === null) {
      number.textContent = status && !status.sensorOk ? "kein Messwert" : "–";
    } else {
      number.textContent = formatNumber(value, series.digits) + " ";
      const unit = document.createElement("small");
      unit.textContent = series.unit;
      number.append(unit);
      if (series.key === "co2") {
        const rating = co2Rating(value);
        color = ratingColor(rating.level);
        note.textContent = rating.text;
        note.className = `rating ${rating.level}`;
        tile.classList.add("co2");
      }
    }
    tile.style.setProperty("--color", color);
    tile.append(label, number, note);
    ui.live.append(tile);
  }
  if (status && !status.sensorOk) {
    const hint = document.createElement("p");
    hint.className = "message";
    hint.textContent =
      "Der SCD30 liefert keine Messwerte. Verdrahtung prüfen (SDA GPIO 6, SCL GPIO 7). " +
      "Nach dem Einschalten dauert die erste Messung einige Sekunden.";
    ui.live.append(hint);
  }
}

// --- Sensor & Display ---------------------------------------------------

function renderConfig() {
  const connected = isConnected() && config !== null;
  if (!isConnected()) {
    ui.sensorInfo.textContent = "Nicht verbunden";
  } else if (!config || !config.valid) {
    ui.sensorInfo.textContent = "Der SCD30 wurde noch nicht gefunden, seine Einstellungen sind unbekannt.";
  } else {
    ui.sensorInfo.textContent =
      `ASC ${config.asc ? "ein" : "aus"}, Temperatur-Offset ${formatNumber(config.tempOffset, 2)} K, ` +
      `Höhe ${config.altitude.toLocaleString("de-DE")} m.`;
  }
  if (!connected) {
    updateControls();
    return;
  }
  ui.asc.checked = config.asc;
  ui.displayOn.checked = config.displayOn;
  if (document.activeElement !== ui.contrast) {
    ui.contrast.value = String(config.contrast);
  }
  if (document.activeElement !== ui.tempOffset) {
    ui.tempOffset.value = config.tempOffset.toFixed(2);
  }
  if (document.activeElement !== ui.altitude) {
    ui.altitude.value = String(config.altitude);
  }
  updateControls();
}

function parseNumber(text) {
  const trimmed = String(text).trim().replace(",", ".");
  const value = Number(trimmed);
  return trimmed === "" || !Number.isFinite(value) ? null : value;
}

async function calibrateFrc() {
  const ppm = parseNumber(ui.frcPpm.value);
  if (ppm === null || ppm < 400 || ppm > 2000) {
    showMessage("Der Referenzwert muss zwischen 400 und 2000 ppm liegen.");
    return;
  }
  if (!confirm(
    `Den SCD30 jetzt auf ${Math.round(ppm)} ppm kalibrieren? Er muss seit mindestens 2 Minuten ` +
    "bei genau dieser Konzentration laufen, zum Beispiel draußen."
  )) {
    return;
  }
  await sendCommand(CMD_FRC, Math.round(ppm));
  showMessage(`Auf ${Math.round(ppm)} ppm kalibriert. Der nächste Messwert sollte jetzt etwa diesen Wert zeigen.`);
}

async function saveTempOffset() {
  const value = parseNumber(ui.tempOffset.value);
  if (value === null || value < 0 || value > 20) {
    showMessage("Der Temperatur-Offset muss zwischen 0 und 20 K liegen.");
    return;
  }
  await sendCommand(CMD_TEMP_OFFSET, Math.round(value * 100));
  ui.tempOffset.blur();
  showMessage("");
}

async function saveAltitude() {
  const value = parseNumber(ui.altitude.value);
  if (value === null || value < 0 || value > 3000) {
    showMessage("Die Höhe muss zwischen 0 und 3000 m liegen.");
    return;
  }
  await sendCommand(CMD_ALTITUDE, Math.round(value));
  ui.altitude.blur();
  showMessage("");
}

// --- Reiter -------------------------------------------------------------

function showTab(name) {
  if (![...ui.tabs].some((tab) => tab.dataset.tab === name)) {
    name = "main";
  }
  for (const tab of ui.tabs) {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  }
  for (const page of ui.pages) {
    page.hidden = page.dataset.page !== name;
  }
  try {
    localStorage.setItem(TAB_STORAGE_KEY, name);
  } catch (e) {}
  if (name === "main") {
    drawCharts();  // Diagramme haben im versteckten Reiter keine Groesse
  } else {
    renderConfig();
  }
}

// --- Verlauf ------------------------------------------------------------

function formatTime(epoch) {
  return new Date(epoch * 1000).toLocaleString("de-DE");
}

function timedRecords() {
  return records.filter((record) => record.epoch > 0);
}

function renderHistory() {
  renderCalendar();
  const timed = timedRecords();
  const dayText = dayMode()
    ? selectedDay.toLocaleDateString("de-DE", { weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" }) + ": "
    : "";
  if (records.length === 0 && !isConnected()) {
    ui.history.textContent = localDays.size > 0
      ? `${dayText}keine Daten im Browser gespeichert`
      : "Noch keine Daten geladen";
  } else if (records.length === 0) {
    ui.history.textContent = dayMode() ? `${dayText}keine Messwerte` : "Keine Logdaten vorhanden";
  } else if (dayMode()) {
    ui.history.textContent = `${dayText}${records.length.toLocaleString("de-DE")} Datensätze`;
  } else {
    let text = `${records.length.toLocaleString("de-DE")} Datensätze`;
    if (timed.length > 0) {
      text += `, ${formatTime(timed[0].epoch)} bis ${formatTime(timed[timed.length - 1].epoch)}`;
    }
    const missing = records.length - timed.length;
    if (missing > 0) {
      text += `. ${missing.toLocaleString("de-DE")} davon ohne Uhrzeit, sie fehlen im ` +
        "Diagramm und stehen ohne Datum in der CSV-Datei.";
    }
    ui.history.textContent = text;
  }
  if (recordsFromBrowser && records.length > 0) {
    ui.history.textContent += " (aus dem Browser-Speicher)";
  }

  drawCharts();
  updateControls();
}

// --- Diagramme ----------------------------------------------------------

// Gespeichert werden die ausgeblendeten Diagramme, damit neue Messgroessen
// automatisch erscheinen.
function saveSeriesSelection() {
  try {
    const hidden = SERIES.map((s) => s.key).filter((key) => !visibleSeries.includes(key));
    localStorage.setItem(SERIES_STORAGE_KEY, JSON.stringify(hidden));
  } catch (e) {}
}

function loadSeriesSelection() {
  try {
    const hidden = JSON.parse(localStorage.getItem(SERIES_STORAGE_KEY));
    if (Array.isArray(hidden)) {
      visibleSeries = SERIES.map((s) => s.key).filter((key) => !hidden.includes(key));
    }
  } catch (e) {}
}

// Auswahl, welche Diagramme angezeigt werden
function renderSeriesToggles() {
  ui.seriesToggles.replaceChildren();
  for (const series of SERIES) {
    const label = document.createElement("label");
    label.className = "check";
    label.style.setProperty("--color", seriesColor(series));
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = visibleSeries.includes(series.key);
    box.addEventListener("change", () => {
      visibleSeries = SERIES.map((s) => s.key).filter((key) =>
        key === series.key ? box.checked : visibleSeries.includes(key)
      );
      saveSeriesSelection();
      renderCharts();
    });
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    label.append(box, swatch, document.createTextNode(series.label));
    ui.seriesToggles.append(label);
  }
}

// Je sichtbarer Messgroesse eine Karte mit Titel, Diagramm und Werten am Fadenkreuz
function renderCharts() {
  ui.chartList.replaceChildren();
  chartViews = [];
  const shown = SERIES.filter((s) => visibleSeries.includes(s.key));
  if (shown.length === 0) {
    const hint = document.createElement("p");
    hint.className = "muted";
    hint.textContent = "Kein Diagramm gewählt.";
    ui.chartList.append(hint);
  }
  for (const series of shown) {
    const card = document.createElement("div");
    card.className = "chart-card single";
    card.style.setProperty("--color", seriesColor(series));
    const head = document.createElement("div");
    head.className = "chart-head";
    const title = document.createElement("h3");
    title.textContent = `${series.label} (${series.unit})`;
    head.append(title);
    const canvas = document.createElement("canvas");
    addPointerHandlers(canvas);
    const tooltip = document.createElement("p");
    tooltip.className = "tooltip";
    card.append(head, canvas, tooltip);
    ui.chartList.append(card);
    chartViews.push({ series, canvas, tooltip });
  }
  drawCharts();
}

// Zeitachse aller Diagramme: im Kalender der gewaehlte Ausschnitt des Tages,
// sonst die geladenen Daten
function chartSpan(points) {
  if (points.length === 0) {
    return null;
  }
  if (dayMode()) {
    return dayWindow();
  }
  return [points[0].epoch, Math.max(points[points.length - 1].epoch, points[0].epoch + 60)];
}

// --- Ausschnitt im Tagesverlauf ------------------------------------------

function zoomSeconds() {
  return dayMode() ? Number(ui.zoom.value) : 0;
}

// Spaetestes Ende des Ausschnitts: heute jetzt, an anderen Tagen das Tagesende.
function latestWindowEnd(seconds) {
  const [dayStart, dayEnd] = dayBounds();
  const now = Math.floor(Date.now() / 1000);
  return Math.max(Math.min(dayEnd, now), dayStart + seconds);
}

function dayWindow() {
  const [dayStart, dayEnd] = dayBounds();
  const seconds = zoomSeconds();
  if (!seconds || seconds >= dayEnd - dayStart) {
    return [dayStart, dayEnd];
  }
  const latest = latestWindowEnd(seconds);
  const end = Math.max(dayStart + seconds, viewEnd === null ? latest : Math.min(viewEnd, latest));
  return [end - seconds, end];
}

// Verschiebt den Ausschnitt um einen halben Ausschnitt, -1 frueher, +1 spaeter.
function pan(direction) {
  const seconds = zoomSeconds();
  if (!seconds) {
    return;
  }
  const [dayStart] = dayBounds();
  const latest = latestWindowEnd(seconds);
  const end = dayWindow()[1] + (direction * seconds) / 2;
  const clamped = Math.min(Math.max(end, dayStart + seconds), latest);
  viewEnd = clamped >= latest ? null : clamped;
  hoverEpoch = null;
  drawCharts();
}

function formatClock(epoch, dayEnd) {
  if (epoch === dayEnd) {
    return "24:00";
  }
  return new Date(epoch * 1000).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
}

function renderZoom() {
  ui.zoomControls.hidden = !dayMode();
  if (!dayMode()) {
    return;
  }
  const seconds = zoomSeconds();
  const [dayStart, dayEnd] = dayBounds();
  const [start, end] = dayWindow();
  ui.zoomRange.textContent = `${formatClock(start, dayEnd)} – ${formatClock(end, dayEnd)}`;
  ui.panPrev.disabled = !seconds || start <= dayStart;
  ui.panNext.disabled = !seconds || end >= latestWindowEnd(seconds);
}

function drawCharts() {
  renderZoom();
  const points = timedRecords().sort((a, b) => a.epoch - b.epoch);
  const span = chartSpan(points);
  for (const view of chartViews) {
    drawChart(view.canvas, view.series, view.tooltip, points, span);
  }
}

function niceStep(raw) {
  const power = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

function chartArea(width, height) {
  return { left: 48, right: width - 8, top: 8, bottom: height - 22 };
}

function drawChart(canvas, series, tooltip, points, span) {
  const key = series.key;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0) {
    return;
  }
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.font = "12px system-ui, sans-serif";

  const area = chartArea(width, height);
  const muted = cssVar("--muted");
  const border = cssVar("--border");
  const color = seriesColor(series);

  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.strokeRect(area.left, area.top, area.right - area.left, area.bottom - area.top);

  // Nur Punkte im Ausschnitt zaehlen fuer Achse und Fadenkreuz. Gezeichnet wird je
  // ein Punkt davor und danach mit, damit die Linien bis an den Rand gehen.
  let first = 0;
  let last = points.length - 1;
  if (span) {
    while (first < points.length && points[first].epoch < span[0]) {
      first++;
    }
    while (last >= 0 && points[last].epoch > span[1]) {
      last--;
    }
  }
  const inside = points.slice(first, last + 1);
  points = points.slice(Math.max(0, first - 1), Math.min(points.length, last + 2));

  let min = Infinity;
  let max = -Infinity;
  for (const record of inside) {
    const v = record[key];
    if (v !== null) {
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
  }
  if (!span || !Number.isFinite(min)) {
    tooltip.textContent = "";
    ctx.fillStyle = muted;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Keine Daten", (area.left + area.right) / 2, (area.top + area.bottom) / 2);
    return;
  }
  // Kleine Schwankungen nicht zu stark vergroessern
  if (max - min < series.minSpan) {
    const mid = (max + min) / 2;
    min = mid - series.minSpan / 2;
    max = mid + series.minSpan / 2;
  }
  const pad = (max - min) * 0.08;
  min -= pad;
  max += pad;
  if (key !== "temp") {
    min = Math.max(0, min);
  }
  if (key === "hum") {
    max = Math.min(100, max);
  }

  const [startEpoch, endEpoch] = span;
  const duration = endEpoch - startEpoch;
  const toX = (epoch) => area.left + ((epoch - startEpoch) / duration) * (area.right - area.left);
  const toY = (value) => area.bottom - ((value - min) / (max - min)) * (area.bottom - area.top);

  // Beim CO2 die Grenzen der Bewertung als farbige Linien
  if (key === "co2") {
    ctx.save();
    ctx.setLineDash([6, 4]);
    for (const [limit, level] of [[CO2_GOOD, "medium"], [CO2_MEDIUM, "high"], [CO2_BAD, "bad"]]) {
      if (limit > min && limit < max) {
        ctx.strokeStyle = ratingColor(level);
        ctx.beginPath();
        ctx.moveTo(area.left, toY(limit));
        ctx.lineTo(area.right, toY(limit));
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // Hilfslinien und Beschriftung der Werteachse
  ctx.strokeStyle = border;
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const yStep = niceStep((max - min) / (height > 200 ? 5 : 3));
  for (let v = Math.ceil(min / yStep) * yStep; v <= max; v += yStep) {
    ctx.beginPath();
    ctx.moveTo(area.left, toY(v));
    ctx.lineTo(area.right, toY(v));
    ctx.stroke();
    const label = Math.abs(v) < yStep / 1000 ? 0 : v;  // sonst steht dort "-0"
    ctx.fillText(formatNumber(label, yStep < 1 ? 1 : 0), area.left - 6, toY(v));
  }

  // Zeitachse, an der Ortszeit ausgerichtet
  const offset = -new Date().getTimezoneOffset() * 60;
  const steps = [60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 604800, 2592000];
  const maxTicks = width > 500 ? 6 : 4;
  const xStep = steps.find((s) => duration / s <= maxTicks) || steps[steps.length - 1];
  ctx.textBaseline = "top";
  for (let t = Math.ceil((startEpoch + offset) / xStep) * xStep - offset; t <= endEpoch; t += xStep) {
    ctx.beginPath();
    ctx.moveTo(toX(t), area.top);
    ctx.lineTo(toX(t), area.bottom);
    ctx.stroke();
    const date = new Date(t * 1000);
    const label = xStep >= 86400
      ? date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" })
      : date.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
    const x = toX(t);
    ctx.textAlign = x > area.right - 20 ? "right" : x < area.left + 20 ? "left" : "center";
    ctx.fillText(label, x, area.bottom + 6);
  }

  // Bei vielen Punkten reicht ein Punkt je Bildschirmpixel.
  const step = Math.max(1, Math.floor(points.length / (area.right - area.left)));
  // Luecken (Stromausfall) werden nicht verbunden.
  const maxGap = Math.max(300, (status ? status.intervalS : 60) * 3) * step;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top);
  ctx.clip();
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.beginPath();
  let previousEpoch = null;
  for (let i = 0; i < points.length; i += step) {
    const record = points[i];
    const v = record[key];
    if (v === null) {
      previousEpoch = null;
      continue;
    }
    if (previousEpoch === null || record.epoch - previousEpoch > maxGap) {
      ctx.moveTo(toX(record.epoch), toY(v));
    } else {
      ctx.lineTo(toX(record.epoch), toY(v));
    }
    previousEpoch = record.epoch;
  }
  ctx.stroke();
  ctx.restore();

  // Fadenkreuz mit den Werten des naechsten Datensatzes im Ausschnitt
  if (hoverEpoch === null || inside.length === 0) {
    tooltip.textContent = "";
    return;
  }
  const record = nearestRecord(inside, hoverEpoch);
  const x = toX(record.epoch);
  ctx.strokeStyle = muted;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(x, area.top);
  ctx.lineTo(x, area.bottom);
  ctx.stroke();
  ctx.setLineDash([]);

  tooltip.replaceChildren();
  const when = document.createElement("b");
  when.textContent = formatTime(record.epoch);
  tooltip.append(when);
  const v = record[key];
  if (v !== null) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, toY(v), 4, 0, Math.PI * 2);
    ctx.fill();
    let text = `  ${formatNumber(v, series.digits)} ${series.unit}`;
    if (key === "co2") {
      text += ` – ${co2Rating(v).text}`;
    }
    tooltip.append(document.createTextNode(text));
  }
}

function nearestRecord(points, epoch) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].epoch < epoch) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return Math.abs(points[lo].epoch - epoch) <= Math.abs(points[hi].epoch - epoch) ? points[lo] : points[hi];
}

// Das Fadenkreuz steht in allen Diagrammen an derselben Zeit.
function onPointer(event) {
  const span = chartSpan(timedRecords().sort((a, b) => a.epoch - b.epoch));
  if (!span) {
    return;
  }
  const [startEpoch, endEpoch] = span;
  const rect = event.currentTarget.getBoundingClientRect();
  const area = chartArea(rect.width, rect.height);
  const fraction = (event.clientX - rect.left - area.left) / (area.right - area.left);
  hoverEpoch = startEpoch + Math.min(1, Math.max(0, fraction)) * (endEpoch - startEpoch);
  drawCharts();
}

function addPointerHandlers(canvas) {
  canvas.addEventListener("pointermove", onPointer);
  canvas.addEventListener("pointerdown", onPointer);
  canvas.addEventListener("pointerleave", () => {
    hoverEpoch = null;
    drawCharts();
  });
}

// --- Logdaten im Browser -------------------------------------------------

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB wird nicht unterstützt"));
        return;
      }
      const request = indexedDB.open(DB_NAME, 1);
      // Schluessel ist die Unix-Zeit. Indizes des ESP32 beginnen nach "Log loeschen"
      // wieder bei 0 und taugen deshalb nicht als Schluessel.
      request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: "epoch" });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function toStored(record) {
  return { epoch: record.epoch, uptimeS: record.uptimeS, co2: record.co2, temp: record.temp, hum: record.hum };
}

function fromStored(item) {
  return withDerived({
    index: -1,
    epoch: item.epoch,
    uptimeS: item.uptimeS,
    co2: item.co2 ?? null,
    temp: item.temp ?? null,
    hum: item.hum ?? null,
  });
}

async function flushLocal(refresh = true) {
  if (pendingLocal.length === 0) {
    if (refresh) {
      await refreshLocalInfo();
    }
    return;
  }
  const batch = pendingLocal;
  pendingLocal = [];
  try {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    for (const record of batch) {
      store.put(toStored(record));
    }
    await idbTransaction(tx);
    // Den Browser bitten, die Daten nicht bei Speichermangel zu verwerfen.
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist().catch(() => {});
    }
    if (refresh) {
      await refreshLocalInfo();
    }
  } catch (error) {
    showMessage(`Daten konnten nicht im Browser gespeichert werden: ${error.message}`);
  }
}

async function loadLocalRange(start, end) {
  const db = await openDb();
  const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
  const range = Number.isFinite(end) ? IDBKeyRange.bound(start, end, false, true) : IDBKeyRange.lowerBound(start);
  const items = await idbRequest(store.getAll(range));
  return items.map(fromStored);
}

// Ohne Verbindung den gewaehlten Zeitraum aus dem Browser zeigen
async function loadLocal() {
  if (isConnected()) {
    return;
  }
  let start = 0;
  let end = Infinity;
  if (dayMode()) {
    [start, end] = dayBounds();
  } else {
    const days = Number(ui.range.value);
    if (days > 0) {
      start = Math.floor(Date.now() / 1000) - days * 86400;
    }
  }
  const token = ++localLoadToken;
  let list = [];
  try {
    list = await loadLocalRange(start, end);
  } catch (error) {
    showMessage(`Daten im Browser nicht lesbar: ${error.message}`);
  }
  if (token !== localLoadToken || isConnected()) {
    return;
  }
  records = list;
  recordsFromBrowser = true;
  hoverEpoch = null;
  renderHistory();
}

// Anzahl, Zeitraum und Tage mit Daten fuer Anzeige und Kalender
async function refreshLocalInfo() {
  try {
    const db = await openDb();
    const store = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE);
    const keys = await idbRequest(store.getAllKeys());
    localDays = new Set();
    for (const epoch of keys) {
      localDays.add(startOfDay(new Date(epoch * 1000)).getTime());
    }
    localFirstDay = keys.length ? startOfDay(new Date(keys[0] * 1000)) : null;
    ui.localInfo.textContent = keys.length
      ? `Im Browser gespeichert: ${keys.length.toLocaleString("de-DE")} Datensätze vom ` +
        `${formatTime(keys[0])} bis ${formatTime(keys[keys.length - 1])}`
      : "Im Browser gespeichert: keine Daten";
  } catch (error) {
    ui.localInfo.textContent = `Im Browser gespeichert: nicht verfügbar (${error.message})`;
  }
  ui.clearLocal.disabled = localDays.size === 0 || Boolean(archive);
  renderCalendar();
}

async function clearLocal() {
  if (!confirm("Alle lokal im Browser gespeicherten Logdaten löschen? Die Daten auf dem ESP32 bleiben.")) {
    return;
  }
  pendingLocal = [];
  const db = await openDb();
  const tx = db.transaction(DB_STORE, "readwrite");
  tx.objectStore(DB_STORE).clear();
  await idbTransaction(tx);
  await refreshLocalInfo();
  if (!isConnected()) {
    records = [];
    renderHistory();
  }
}

// --- CSV ----------------------------------------------------------------

function pad(value) {
  return String(value).padStart(2, "0");
}

function csvDate(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function csvTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

// Semikolon und Dezimalkomma, damit ein deutsches Excel die Datei direkt oeffnet.
function downloadCsv() {
  const header = ["Datum", "Uhrzeit", "Laufzeit_s", "CO2_ppm", "Temperatur_C", "Luftfeuchte_%", "Taupunkt_C",
    "Absolute_Feuchte_g/m3"];
  const lines = [header.join(";")];
  for (const record of records) {
    const date = new Date(record.epoch * 1000);
    lines.push(
      [
        record.epoch > 0 ? csvDate(date) : "",
        record.epoch > 0 ? csvTime(date) : "",
        record.uptimeS,
        ...SERIES.map((s) =>
          record[s.key] === null ? "" : record[s.key].toFixed(s.csvDigits).replace(".", ",")
        ),
      ].join(";")
    );
  }
  const blob = new Blob(["﻿" + lines.join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const now = new Date();
  link.href = URL.createObjectURL(blob);
  link.download = dayMode()
    ? `co2_${selectedDay.getFullYear()}-${pad(selectedDay.getMonth() + 1)}-${pad(selectedDay.getDate())}.csv`
    : `co2_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// --- Bedienung ----------------------------------------------------------

function updateControls() {
  const connected = isConnected() && status !== null;
  ui.refresh.disabled = !connected || syncing;
  ui.download.disabled = records.length === 0 || syncing;
  ui.interval.disabled = !connected;
  ui.clear.disabled = !connected || syncing;
  ui.archive.disabled = !connected;
  ui.clearLocal.disabled = localDays.size === 0 || Boolean(archive);
  if (archive) {
    ui.refresh.disabled = true;
    ui.clear.disabled = true;
  }
  const sensorConfig = connected && config !== null && config.valid;
  for (const control of [ui.asc, ui.frc, ui.frcPpm, ui.tempOffset, ui.saveTempOffset, ui.altitude, ui.saveAltitude]) {
    control.disabled = !sensorConfig;
  }
  const displayConfig = connected && config !== null;
  ui.displayOn.disabled = !displayConfig;
  ui.contrast.disabled = !displayConfig;
}

async function run(action) {
  try {
    await action();
  } catch (error) {
    showMessage(`Befehl fehlgeschlagen: ${error.message}`);
  }
}

ui.connect.addEventListener("click", () => {
  if (device && device.gatt.connected) {
    device.gatt.disconnect();
  } else {
    connect();
  }
});

ui.range.addEventListener("change", () => {
  hoverEpoch = null;
  try {
    localStorage.setItem(RANGE_STORAGE_KEY, ui.range.value);
  } catch (e) {}
  if (dayMode()) {
    run(loadDay);
    return;
  }
  renderCalendar();
  if (!isConnected()) {
    run(loadLocal);
    return;
  }
  run(async () => {
    if (syncing) {
      syncing = false;
      await sendCommand(CMD_DOWNLOAD_CANCEL);
    }
    resetRecords();
    renderHistory();
    await startSync();
  });
});

ui.zoom.addEventListener("change", () => {
  try {
    localStorage.setItem(ZOOM_STORAGE_KEY, ui.zoom.value);
  } catch (e) {}
  viewEnd = null;
  hoverEpoch = null;
  drawCharts();
});
ui.panPrev.addEventListener("click", () => pan(-1));
ui.panNext.addEventListener("click", () => pan(1));

ui.calPrev.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  renderCalendar();
});
ui.calNext.addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  renderCalendar();
});
ui.dayPrev.addEventListener("click", () => selectDay(addDays(selectedDay, -1)));
ui.dayNext.addEventListener("click", () => selectDay(addDays(selectedDay, 1)));
ui.dayToday.addEventListener("click", () => selectDay(new Date()));

ui.clearLocal.addEventListener("click", () => run(clearLocal));
ui.archive.addEventListener("click", () => run(archive ? cancelArchive : startArchive));
ui.refresh.addEventListener("click", () => run(startSync));
ui.download.addEventListener("click", downloadCsv);
ui.interval.addEventListener("change", () => run(() => sendCommand(CMD_SET_INTERVAL, Number(ui.interval.value))));

ui.asc.addEventListener("change", () => run(() => sendCommand(CMD_ASC, ui.asc.checked ? 1 : 0)));
ui.frc.addEventListener("click", () => run(calibrateFrc));
ui.saveTempOffset.addEventListener("click", () => run(saveTempOffset));
ui.tempOffset.addEventListener("keydown", (event) => {
  if (event.key === "Enter") run(saveTempOffset);
});
ui.saveAltitude.addEventListener("click", () => run(saveAltitude));
ui.altitude.addEventListener("keydown", (event) => {
  if (event.key === "Enter") run(saveAltitude);
});
ui.displayOn.addEventListener("change", () => run(() => sendCommand(CMD_DISPLAY_ON, ui.displayOn.checked ? 1 : 0)));
// Erst beim Loslassen senden, nicht bei jedem Zwischenwert
ui.contrast.addEventListener("change", () => run(() => sendCommand(CMD_DISPLAY_CONTRAST, Number(ui.contrast.value))));

for (const tab of ui.tabs) {
  tab.addEventListener("click", () => showTab(tab.dataset.tab));
}

ui.clear.addEventListener("click", () => {
  if (confirm("Alle Logdaten auf dem ESP32 unwiderruflich löschen?")) {
    run(async () => {
      await sendCommand(CMD_LOG_CLEAR);
      records = [];
      nextRecord = 0;
      renderHistory();
    });
  }
});

window.addEventListener("resize", drawCharts);
// Beim Schliessen oder Wechseln der Seite noch nicht gespeicherte Daten sichern
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    flushLocal();
  }
});
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderLive();
  renderSeriesToggles();
  renderCharts();
});

if (!navigator.bluetooth) {
  ui.connect.disabled = true;
  showMessage(
    "Dieser Browser unterstützt Web Bluetooth nicht, oder die Seite läuft nicht über " +
      "HTTPS bzw. localhost. Nutze Chrome oder Edge auf Android oder dem PC."
  );
}

// Gespeicherte Einstellungen aus der letzten Sitzung
function restoreSelect(select, key) {
  const saved = localStorage.getItem(key);
  if (saved !== null && [...select.options].some((option) => option.value === saved)) {
    select.value = saved;
  }
}

try {
  restoreSelect(ui.zoom, ZOOM_STORAGE_KEY);
  restoreSelect(ui.range, RANGE_STORAGE_KEY);
} catch (e) {}
loadSeriesSelection();
renderSeriesToggles();
renderCharts();
renderHistory();
renderConfig();
let savedTab = "main";
try {
  savedTab = localStorage.getItem(TAB_STORAGE_KEY) || "main";
} catch (e) {}
showTab(savedTab);
refreshLocalInfo().then(() => loadLocal());

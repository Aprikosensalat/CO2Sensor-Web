# CO2-Sensor, Website

Stand: 18.11.2026

Statische Website ohne Build-Schritt. Sie verbindet sich per Web Bluetooth mit der
Firmware im privaten Projekt [CO2Sensor](https://github.com/Aprikosensalat/CO2Sensor)
(SCD30 am ESP32-C3). Aufbau und Funktionen sind von
`HeizkreisTemperaturen-Web` übernommen.

## Aktueller Stand

| Punkt | Status |
|---|---|
| Website | fertig geschrieben |
| Geprüft | in headless Firefox mit simuliertem ESP32 (2 Tage Log, 1 min Intervall, Lücke ohne Uhrzeit): Kacheln, Bewertung, Kalender, drei Diagramme mit CO₂-Grenzlinien, Speicheranzeige und der Reiter „Sensor & Display“ werden richtig angezeigt, ohne JavaScript-Fehler, auch in Handybreite |
| Nicht geprüft | echte BLE-Verbindung, Log-Download, Kalibrierung, CSV-Download, Daten im Browser |

## Starten

Web Bluetooth läuft nur über HTTPS oder `localhost`. Am PC:

```
python3 -m http.server 8000
```

Danach `http://localhost:8000` in Chrome oder Edge öffnen. Firefox und Safari
unterstützen Web Bluetooth nicht.

**Online:** https://aprikosensalat.github.io/CO2Sensor-Web/

Die Seite liegt auf GitHub Pages (Branch `main`, Ordner `/`). Jeder Push auf `main`
veröffentlicht sie nach etwa einer Minute neu. Das Repo ist öffentlich, weil GitHub Pages
im kostenlosen Plan nur für öffentliche Repos geht. Auf dem Smartphone in Chrome öffnen
und bei Bedarf über das Menü „Zum Startbildschirm hinzufügen“.

## Dateien

| Datei | Inhalt |
|---|---|
| [index.html](index.html) | Seitenaufbau |
| [style.css](style.css) | Darstellung, heller und dunkler Modus, Handy-Layout |
| [app.js](app.js) | BLE-Verbindung, Log-Abgleich, Kalender, Diagramme, CSV-Export |

Die UUIDs in `app.js` müssen zu denen in `src/main.cpp` der Firmware passen. Das
BLE-Protokoll steht in der README der Firmware.

## Funktionen

- **Messwerte:** Kacheln für CO₂, Temperatur und Luftfeuchte, alle 2 s aktualisiert. Die
  CO₂-Kachel zeigt die Bewertung farbig: unter 800 ppm gut, bis 1000 mittel, bis 1400
  „Lüften empfohlen“, darüber schlecht.
- **Berechnete Werte:** Taupunkt (Magnus-Formel) und absolute Feuchte in g/m³, aus
  Temperatur und Luftfeuchte berechnet, als eigene Kacheln, Diagramme und CSV-Spalten.
  Sie werden im Browser berechnet und nicht übertragen oder geloggt.
- **Verlauf:** je ein Diagramm für CO₂, Temperatur, Luftfeuchte, Taupunkt und absolute Feuchte, einzeln ein- und
  ausblendbar. Im CO₂-Diagramm zeigen gestrichelte Linien die Grenzen 800, 1000 und
  1400 ppm. Das Fadenkreuz steht in allen Diagrammen an derselben Zeit.
- **Kalender, Ausschnitt, Zeiträume:** wie im Heizkreis-Projekt: Tag aus Kalender mit Zoom
  von 15 min bis zum ganzen Tag, oder letzte 24 h, 7 Tage, 30 Tage, alles.
- **Einstellungen:** Log-Intervall, Speicheranzeige, Log löschen.
- **Daten im Browser:** Geladene Datensätze bleiben in IndexedDB und sind ohne Verbindung
  abrufbar. „Alles vom ESP32 in den Browser laden“ holt das ganze Log.
- **Sensor & Display:** ASC ein/aus, Kalibrierung auf einen Referenzwert (FRC),
  Temperatur-Offset, Höhe, Display ein/aus und Helligkeit.
- **CSV-Export:** `co2_<Datum>.csv` mit Semikolon und Dezimalkomma:

```
Datum;Uhrzeit;Laufzeit_s;CO2_ppm;Temperatur_C;Luftfeuchte_%;Taupunkt_C;Absolute_Feuchte_g/m3
18.11.2026;14:30:00;3725;812;21,87;46,3;9,8;8,94
```

## Einschränkungen

- Chrome oder Edge auf Android oder dem PC. Safari auf dem iPhone geht nicht.
- Keine Kopplung und kein Passwort.
- Die Daten im Browser gelten nur für diesen Browser auf diesem Gerät.

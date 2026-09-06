# node-red-contrib-myhome-own-mqtt

[![npm version](https://img.shields.io/npm/v/node-red-contrib-myhome-own-mqtt.svg)](https://www.npmjs.com/package/node-red-contrib-myhome-own-mqtt)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

Un bridge bidirezionale professionale, performante e affidabile tra **BTicino / Legrand MyHome SCS OpenWebNet (OWN)** e **MQTT** per **Node-RED**.

Progettato con **zero dipendenze esterne** (utilizza esclusivamente i moduli nativi Node.js `net` e `crypto`) e dotato di **doppia uscita**:
1. **Uscita 1 (MQTT)**: invia topic strutturati e payload JSON formattati per broker MQTT e controller domotici (es. Home Assistant).
2. **Uscita 2 (OWN)**: trasmette i frame grezzi OpenWebNet del bus *as-is* in chiaro (es. `*1*1*21##`), ideali per log, diagnostica, filtraggio o elaborazioni custom.

Include inoltre l'**Auto-Discovery MQTT per Home Assistant** opzionale, che genera e pubblica automaticamente i topic di configurazione persistenti (`retain: true`), rendendo luci, tapparelle, termostati e contatti immediatamente visibili in Home Assistant senza dover scrivere alcuna riga di YAML!

---

## Caratteristiche Principali

- **Connessione Gateway Robusta e Resiliente**:
  - Sessione TCP di monitoraggio persistente (`*99*1##`) con riconnessione automatica a backoff esponenziale (da 500 ms a 30 s).
  - Supporto per tutti i metodi di autenticazione OpenWebNet: nessuna password (whitelist IP), password numerica OpenPass di base e **HMAC SHA-1 / SHA-256** (per gateway recenti come MyHOMEServer1, F454, MH200N).
  - Esecuzione comandi sicura e serializzata tramite sessioni di comando dedicate (`*99*0##`) con intervallo di cadenza configurabile tra un invio e il successivo.
  - Watchdog periodico dello stato di connessione con interrogazione diagnostica (`*#13**15##`).

- **Traduzione Completa di Tutti i Sottosistemi**:
  - **Illuminazione (WHO = 1)**: Acceso, Spento, Dimmer 10 livelli, Dimmer 100 livelli, Luci temporizzate (11-18), Luci lampeggianti (20-29).
  - **Automazione / Tapparelle (WHO = 2)**: Salita/Apertura, Discesa/Chiusura, Stop, Percentuali di posizione.
  - **Termoregolazione e Clima (WHO = 4)**: Riscaldamento, Condizionamento, Spento, Modalità Automatica; Sonda Master e Sonde Slave (t1–t8); Setpoint e Offset; Velocità Fan-Coil (automatica, bassa, media, alta); Stato valvole e attuatori; Controllo split.
  - **Contatti Puliti / Interfacce (WHO = 25)**: Stato aperto/chiuso, con supporto all'inversione di polarità per singolo contatto.
  - **Pulsanti CEN e CEN+ (WHO = 15, 25)**: Pressione breve, rilascio, pressione prolungata, selettori rotativi (rotazione oraria e antioraria lenta/veloce).
  - **Contatti Ausiliari (WHO = 9)**: Aperto / Chiuso.
  - **Scenari e Programmazione (WHO = 0, 17)**: Attivazione scenari e programmatore scenari.
  - **Diagnostica Gateway (WHO = 13)**: Modello gateway, versione firmware, uptime, data/ora, indirizzo IP, MAC address.
  - **Blocco / Disabilitazione Attuatori (WHO = 14)**: Modalità speciali e disattivazione.

- **Doppia Uscita Indipendente**:
  - **Uscita 1 (MQTT)**: `{ topic: "...", payload: "{...}", qos: 0, retain: false }`
  - **Uscita 2 (OWN)**: `{ payload: "*1*1*21##", topic: "myhome/own/event" }`

- **Home Assistant MQTT Auto-Discovery**:
  - Genera payload conformi agli standard di Home Assistant (`homeassistant/<componente>/.../config`) con flag `retain: true` per luci, coperture/tapparelle, termostati, sensori binari per contatti e stato gateway.

---

## Installazione

### In Node-RED Standard / Locale

Esegui il seguente comando all'interno della cartella utente di Node-RED (solitamente `~/.node-red`):

```bash
cd ~/.node-red
npm install brn78/node-red-contrib-myhome-own-mqtt
```

Oppure cerca `node-red-contrib-myhome-own-mqtt` direttamente nel **Gestore della Tavolozza (Palette Manager)** dell'interfaccia web di Node-RED.

---

### In Home Assistant (Add-on Node-RED)

Se utilizzi l'add-on Node-RED su Home Assistant:

1. Apri **Home Assistant** e vai su **Impostazioni** → **Add-on** → **Node-RED**.
2. Fai clic sulla scheda **Configurazione**.
3. Nella sezione **npm packages**, inserisci:
   ```yaml
   npm_packages:
     - brn78/node-red-contrib-myhome-own-mqtt
   ```
4. Fai clic su **Salva** e **Riavvia** l'add-on. All'avvio, il modulo verrà scaricato e installato automaticamente.

---

## Architettura e Cablaggio dei Flussi

```
                    ┌──────────────────────────────┐
                    │     Gateway MyHome (TCP)     │
                    └──────────────┬───────────────┘
                                   │ OpenWebNet
                                   ▼
[MQTT in / Flow] ──► ┌───────────────────────────┐ ──► Uscita 1: [MQTT out / Broker]
(Comandi / Topic)    │  myhome-own-mqtt (Bridge) │     (JSON formattato & Discovery)
                     └───────────────────────────┘ ──► Uscita 2: [Debug / OWN as-is]
                                                       (es. *1*1*21##)
```

---

## Riferimento dei Topic MQTT

### Topic di Stato (Emessi su Uscita 1)

| Sottosistema | Topic MQTT | Esempio di Payload |
|---|---|---|
| **Luci** | `<WHERE>/<BUS>/light/myhome/status` | `{"state":"ON","brightness":255,"attributes":{...}}` |
| **Automazione / Tapparelle** | `<WHERE>/<BUS>/cover/myhome/status` | `{"state":"opening","position":255,"attributes":{...}}` |
| **Clima (Azione)** | `<ZONE>/action/climate/myhome/status` | `{"state":"heating","attributes":{...}}` |
| **Clima (Temperatura)** | `<ZONE>/temperature/climate/myhome/status` | `{"state":21.5,"attributes":{...}}` |
| **Clima (Sonda Slave)** | `<ZONE>/<SLAVE>/temperature/climate/myhome/status` | `{"state":20.8,"attributes":{...}}` |
| **Clima (Setpoint)** | `<ZONE>/setpoint/climate/myhome/status` | `{"state":20.5,"attributes":{...}}` |
| **Clima (Modalità)** | `<ZONE>/mode/climate/myhome/status` | `{"state":"heat","attributes":{...}}` |
| **Clima (Fan Coil)** | `<ZONE>/fan/climate/myhome/status` | `{"state":"medium","percentage":66,"attributes":{...}}` |
| **Contatto Pulito** | `<NUMBER>/contact/myhome/status` | `{"state":"ON","attributes":{"contact_state":"CLOSED"}}` |
| **Ausiliari** | `<WHERE>/aux/myhome/status` | `{"state":"ON","attributes":{"contact_state":"CLOSED"}}` |
| **Pulsante CEN** | `<WHERE>/<BUTTON>/<BUS>/button/myhome/status` | `{"state":"ON","trigger":"PRESSED","attributes":{...}}` |
| **Pulsante CEN+** | `<WHERE>/<BUTTON>/button/plus/myhome/status` | `{"state":"ON","trigger":"PRESSED","attributes":{...}}` |
| **Scenari** | `<WHERE>/<WHAT>/<BUS>/scenarios/myhome/status` | `{"state":"ON","attributes":{"scenarios":1}}` |
| **Programmatore Scenari** | `<WHERE>/<BUS>/scene/myhome/status` | `{"state":"ON","attributes":{"started":true}}` |
| **Info Gateway** | `gateway/myhome/status` | `{"state":"ON","attributes":{"info":"F454"}}` |
| **Stato Connessione** | `connection/myhome/status` | `{"state":"ON","attributes":{"function":"Connection watchdog"}}` |

`<BUS>` corrisponde a `"00"` per il montante principale oppure da `"01"` a `"15"` per un bus locale d'interfaccia.

---

### Topic di Comando (Ricevuti in Ingresso)

| Comando | Topic MQTT | Payload | Frame OWN Inviato al Bus |
|---|---|---|---|
| **Luce On/Off** | `<WHERE>/<BUS>/light/myhome/set` | `"on"` / `"off"` | `*1*1*<WHERE>##` / `*1*0*<WHERE>##` |
| **Luce Dimmer** | `<WHERE>/<BUS>/brightness/myhome/set` | `0`–`255` | `*#1*<WHERE>*#1*<100-200>*0##` |
| **Controllo Tapparelle** | `<WHERE>/<BUS>/cover/myhome/set` | `"open"`, `"close"`, `"stop"` | `*2*1*<WHERE>##`, `*2*2*<WHERE>##`, `*2*0*<WHERE>##` |
| **Setpoint Clima** | `<ZONE>/setpoint/climate/myhome/set` | `21.5` | `*#4*<ZONE>*#7*1*1*0215##` |
| **Delta Setpoint Clima** | `<ZONE>/setpoint/delta/climate/myhome/set` | `1` o `-1` | Incrementa o decrementa il setpoint |
| **Modalità Clima** | `<ZONE>/mode/climate/myhome/set` | `"heat"`, `"cool"`, `"auto"`, `"off"` | Invia il comando di modalità corrispondente |
| **Ventola Clima** | `<ZONE>/fan/climate/myhome/set` | `"auto"`, `"low"`, `"medium"`, `"high"` | `*#4*<ZONE>*#11*<velocità>##` |
| **Controllo Scena** | `<WHERE>/<BUS>/scene/myhome/set` | `"on"`, `"off"`, `"enabled"`, `"disabled"` | `*17*<1-4>*<WHERE>##` |
| **Attivazione Scenario** | `<WHERE>/<BUS>/scenarios/myhome/set` | `1`–`20` | `*0*<WHAT>*<WHERE>##` |
| **Sincronizzazione** | `myhome/sync` oppure `sync/myhome/set` | qualsiasi | Interroga contatti puliti e zone climatiche |
| **Comando Diretto OWN** | *(qualsiasi topic o non specificato)* | `"*1*1*21##"` o array | Invia direttamente la stringa al bus SCS |

---

## Opzioni di Configurazione

### Gateway (`myhome-own-mqtt-gateway`)
- **Host / IP**: Indirizzo IP o hostname del gateway OpenWebNet (es. `192.168.1.35`).
- **Porta**: Porta di comunicazione OpenWebNet (predefinita: `20000`).
- **Password**: Password OpenPass numerica o HMAC alfanumerica. Lasciare vuoto se è attiva l'autorizzazione per intervallo IP.
- **Keep-Alive**: Intervallo in secondi tra i frame di controllo heartbeat (predefinito: `60`).
- **Inter-Command Delay**: Ritardo di cadenza in millisecondi tra comandi consecutivi inviati al bus (predefinito: `50`).

### Nodo Bridge Principale (`myhome-own-mqtt`)
- **Zone Clima**: Elenco separato da virgole delle zone termoregolazione attive (es. `0,21,22,23,24`). `0` rappresenta la Centrale 4/99 zone.
- **Modalità OFF Clima**: Seleziona se lo spegnimento imposta `303` (OFF standard) o `302` (Antigelo / Protezione termica).
- **Contatti Puliti**: Elenco separato da virgole dei numeri dei contatti puliti / interfacce (es. `1,2,3,4`).
- **Contatti Invertiti**: Elenco dei contatti la cui logica di apertura/chiusura è invertita (es. `1,2`).
- **Auto-Discovery**: Attiva la pubblicazione automatica dei messaggi discovery per Home Assistant (`homeassistant/<componente>/.../config`).
- **Prefisso Discovery**: Prefisso MQTT per il discovery (predefinito: `homeassistant`).
- **Sincronizzazione Automatica**: Interroga lo stato dei dispositivi alla connessione del gateway.
- **Sincronizzazione Periodica**: Intervallo in secondi per l'aggiornamento forzato dello stato (predefinito: `300`).
- **Watchdog**: Abilita il controllo periodico dell'effettiva reattività del gateway.

---

## Licenza

MIT © 2026 Bruno Leonardi

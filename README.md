# OneOff
Repository iniziale per progetto OneOff

## Poliritmi — pendoli musicali (`index.html`)

Generatore di poliritmi audiovisivo in un singolo file HTML, senza dipendenze.
Ogni arco è un pendolo che oscilla a una velocità diversa e suona una nota
della scala quando raggiunge un estremo; tutti i pendoli si riallineano alla
fine del ciclo.

### Come si usa
Apri `index.html` in un browser (anche da mobile) e tocca **"Tocca per iniziare"**
per sbloccare l'audio. Il pannello **Impostazioni** in basso permette di:

- **Pendoli (complessità)** — da 2 a 24 pendoli simultanei
- **Visualizzazione** — pendoli su semicerchio (nota a ogni estremo
  dell'oscillazione), orbite su cerchio intero legate al centro con nota
  al passaggio sul punto di innesco in alto, poligoni crescenti
  (triangolo, quadrato, pentagono… con lo stesso periodo di giro: i
  vertici danno un poliritmo 3:4:5… che si riallinea a ogni giro),
  poligoni concentrici: anelli tutti con la stessa forma —
  numero di lati a scelta da 3 a 12 — dove come per i pendoli ogni
  anello interno gira più veloce di quello esterno, oppure spirografo:
  ogni voce è una penna su un doppio braccio rotante (il lungo gira
  lento, il corto controruota veloce) che suona quando i bracci si
  allineano sulla punta di un petalo; la curva epicicloidale, tracciata
  dalla rosa, ha tanti petali quante sono le note per ciclo e si chiude
  esattamente al riallineamento
- **Rosa del ciclo** — le corde che collegano gli elementi adiacenti si
  accumulano su una tela persistente: nell'arco di un ciclo disegnano la
  "rosa" geometrica del poliritmo, che si completa al riallineamento e
  poi riparte
- **Durata ciclo** — tempo di riallineamento completo (15–180 s)
- **Oscillazioni base** — velocità del pendolo più lento (densità ritmica)
- **Scala** — maggiore, minore naturale/armonica, dorica, lidia, misolidia,
  pentatoniche, blues, esatonale, cromatica
- **Fondamentale** — nota radice e ottava
- **Timbro** — morbido, pluck, campana
- **Volume**, pausa/riprendi e reset del ciclo

### Note tecniche
- Audio: Web Audio API con scheduler lookahead sincronizzato su
  `AudioContext.currentTime`, compressore sul master e panning stereo
  in base alla posizione del pendolo.
- Grafica: Canvas 2D con scie e flash sui colpi; layout responsive che
  si adatta al pannello e alla rotazione dello schermo.

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

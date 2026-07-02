# OneOff Splat Studio

Ricostruzione 3D da video, **in locale e in tempo reale**: carichi un video,
guardi la scena crescere nel viewer 3D mentre viene elaborata, e salvi il
risultato come point cloud o Gaussian splat.

Riproduzione dell'applicativo mostrato nel reel Instagram (Lingbot Studio):
video in ingresso → point cloud / splat in uscita, tutto sul proprio computer,
senza GPU e senza servizi cloud.

![OneOff Splat Studio](docs/screenshot.png)

## Avvio

```bash
pip install -r requirements.txt
python -m splat_studio
```

Si apre il browser su `http://127.0.0.1:8765`. Trascina un video nel viewport
(o usa **New Video**) e la ricostruzione parte subito: i punti e le pose della
camera arrivano nel viewer in streaming via WebSocket mentre il video viene
ancora processato (~100 fps su un laptop, più veloce del playback).

## Cosa fa

- **Ricostruzione incrementale (SfM monoculare)** — `splat_studio/pipeline.py`
  - tracking dei corner con optical flow Lucas-Kanade piramidale
    (con verifica di consistenza forward-backward);
  - bootstrap della mappa con matrice essenziale + `recoverPose` tra i primi
    due keyframe;
  - localizzazione dei keyframe successivi con PnP RANSAC sui landmark già
    triangolati;
  - triangolazione di nuovi landmark tra keyframe consecutivi, con filtri su
    cheiralità, errore di riproiezione e parallasse.
- **Viewer 3D live** — `frontend/` (Three.js, vendorizzato: funziona offline)
  - point cloud che cresce in tempo reale, scia dei frustum camera,
    griglia di terra, gizmo degli assi;
  - pannello laterale con frame corrente del video e preset di vista
    (Overview, Front/Back, Left/Right, Top/Bottom, Look At Scene Center,
    Reset up direction).
- **Export** — `splat_studio/export.py`
  - `pointcloud.ply` — point cloud colorata (binary PLY);
  - `scene_3dgs.ply` — formato 3D Gaussian Splatting standard (INRIA), apribile
    in SuperSplat, gsplat, ecc.;
  - `scene.splat` — formato antimatter15/splat.
  - Prima dell'export i punti passano da un filtro statistico di outlier (k-NN).

## Note sul metodo

La pipeline è geometria classica (OpenCV), non una rete neurale: per questo
gira ovunque senza download di modelli né GPU. Le gaussiane esportate sono
inizializzate dai punti triangolati (scala dalla spaziatura locale k-NN,
rotazione identità, colore come termine DC delle armoniche sferiche), non
ottimizzate per fotorealismo come in un training 3DGS completo.

Il video deve contenere **movimento di camera con parallasse** (una camminata,
un orbit attorno a un oggetto…): da un video statico o con sola rotazione non
si può triangolare struttura — in quel caso l'app lo segnala.

## Struttura

```
splat_studio/          backend Python
  pipeline.py          SfM incrementale (LK → essential/PnP → triangolazione)
  jobs.py              job manager + buffering per lo streaming WebSocket
  export.py            exporter PLY / 3DGS PLY / .splat
  server.py            FastAPI: upload, WebSocket, export
  __main__.py          entry point (python -m splat_studio)
frontend/              viewer (HTML/CSS/JS + Three.js vendorizzato)
```

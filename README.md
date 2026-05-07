# 🎮 MindMatch

Game kartu emoji multiplayer real-time!

---

## ✨ Fitur

- 🎴 **Multiplayer Real-Time** hingga 4 pemain per room
- 🎯 **3 Level Kesulitan** — Mudah (4×3), Sedang (6×4), Sulit (8×5)
- 🌟 **5 Tema Kartu** — Hewan, Makanan, Alam, Objek, Luar Angkasa
- ⚡ **Power-Up System** (Mudah & Sedang saja):
  - 👁️ **Intip** — Lihat semua kartu selama 2 detik
  - ❄️ **Bekukan** — Skip giliran lawan berikutnya
  - 🔀 **Acak** — Acak posisi kartu yang belum cocok
- 🔥 **Sistem Combo** — Bonus poin jika berhasil cocokkan beruntun
- ⏰ **Timer Giliran** — 30 detik per giliran
- 💬 **Chat Real-Time** dalam room
- 🏆 **Leaderboard Global** tersimpan permanen
- 📋 **Kode Room** mudah dibagikan

---

## 🚀 Cara Menjalankan

### Persyaratan
- **Node.js** versi 16 atau lebih baru
- Download di: https://nodejs.org

### Langkah-Langkah

**1. Buka Terminal / Command Prompt**

**2. Masuk ke folder proyek:**
```bash
cd memory-game
```

**3. Install dependencies:**
```bash
npm install
```

**4. Jalankan server:**
```bash
npm start
```

**5. Buka browser dan akses:**
```
http://localhost:3000
```

---

## 🎮 Cara Bermain

### Membuat Room
1. Masukkan nama kamu
2. Pilih tingkat kesulitan (Mudah / Sedang / Sulit)
3. Pilih tema kartu favorit
4. Klik **Buat Room**
5. Bagikan kode 6 digit ke teman-temanmu

### Bergabung Room
1. Masukkan nama kamu
2. Klik tab **Gabung Room**
3. Masukkan kode 6 digit dari temanmu
4. Klik **Gabung Room**

### Aturan Permainan
- Pemain bergantian membuka 2 kartu per giliran
- Jika emoji **cocok** → kartu tetap terbuka, pemain dapat poin + main lagi
- Jika emoji **tidak cocok** → kartu tertutup, giliran berpindah
- Combo beruntun memberikan **bonus poin**
- Pemain dengan poin tertinggi di akhir game = **Pemenang**

### Sistem Poin
| Aksi | Poin |
|------|------|
| Pasang cocok | +10 |
| Combo x2 | +15 |
| Combo x3 | +20 |
| Combo xN | +5(N-1) tambahan |

---

## 🌐 Deploy ke Internet (Opsional)

Agar bisa dimainkan dari jaringan berbeda (internet), kamu bisa deploy ke:

### Render.com (Gratis)
1. Buat akun di https://render.com
2. Upload folder proyek ke GitHub
3. Buat **New Web Service** di Render
4. Set Build Command: `npm install`
5. Set Start Command: `npm start`
6. Deploy!

### Railway.app (Gratis)
1. Buat akun di https://railway.app
2. Klik **New Project** → **Deploy from GitHub**
3. Railway akan otomatis mendeteksi Node.js
4. Deploy selesai!

---

## 📁 Struktur File

```
memory-game/
├── server.js          ← Backend server (Node.js + Socket.IO)
├── package.json       ← Konfigurasi proyek
├── data/
│   └── leaderboard.json  ← Data leaderboard (dibuat otomatis)
└── public/
    ├── index.html     ← Tampilan utama
    ├── css/
    │   └── style.css  ← Semua styling
    └── js/
        └── game.js    ← Logic frontend
```

---

## 🛠️ Teknologi

- **Backend**: Node.js, Express.js, Socket.IO
- **Frontend**: HTML5, CSS3, Vanilla JavaScript
- **Real-time**: WebSocket via Socket.IO
- **Storage**: File JSON lokal (tidak perlu database)

---

Dibuat dengan ❤️ untuk tugas proyek multiplayer real-time.

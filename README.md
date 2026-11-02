# IR TickTawk ⏱️🔔

A lightweight Chrome Extension (Manifest V3) that monitors the [Tawk.to Agent Dashboard](https://dashboard.tawk.to/) (`dashboard.tawk.to/#/chat`) to ensure visitor messages never go unanswered.

![IR TickTawk Preview](https://s3.amazonaws.com/tawk-to-pi/f0e6db80e82a123d620d14f1b37b01513a9376a0) <!-- optional -->

## ✨ Features

- **Accurate Waiting Timer**: Automatically detects the incoming visitor's message and parses the actual timestamp (e.g., `4:06 AM`).
- **Refresh & Navigation Resilient**: Persists active countdowns in `chrome.storage.local`—refreshing the dashboard or navigating between dashboard tabs does not reset the timer to zero.
- **2-Minute Chime Alert**: Plays a gentle 3-tone harmonic chime (`E5` → `A5` → `E6`) when a visitor has been waiting for 2 minutes.
- **3-Minute Looping Urgent Alarm**: Sounds a distinct, rhythmic siren every 1.8 seconds once waiting time reaches 3 minutes until an agent replies or clicks **Silence**.
- **Agent Reply Detection**: Automatically resets the timer when the agent sends a reply (presses `Enter` in chat, clicks `Reply`, or an agent message bubble appears).
- **Draggable Floating Badge**: Click and drag the badge anywhere on screen; your custom position is saved across reloads.
- **Always-on-Top Pop-Out (`📌`)**: Use Chrome's Document Picture-in-Picture to pop the badge out into a floating OS-level mini-window that stays visible on top of all desktop apps.
- **Scoped to Dashboard**: Excluded from customer-facing direct chat links (`tawk.to/chat/...`) to keep visitor screens clean.

---

## 🚀 Installation (Load Unpacked)

1. Clone or download this repository:
   ```bash
   git clone https://github.com/mongobread/ir-ticktawk.git
   ```
2. Open Google Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the `ir-ticktawk` folder.
5. Open or refresh `https://dashboard.tawk.to/`.

---

## 🛠️ Tech Stack

- **Chrome Extensions Manifest V3**
- **Web Audio API** (with synthetic PCM WAV fallback for autoplay compliance)
- **Document Picture-in-Picture API**
- **Shadow DOM** for strict CSS isolation from the host dashboard

---

## 📄 License

MIT

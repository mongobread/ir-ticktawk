# Chrome Web Store Listing — IR TickTawk - Tawk.to Response Monitor

> Last Updated: 2026-11-03

## Store Listing

**Extension Name** [REQUIRED]
IR TickTawk - Tawk.to Response Monitor

**Short Description** [REQUIRED]
Monitors dashboard.tawk.to chats with a draggable timer, customizable pre-alarm (1:45) & urgent alarm (3:00), and sound alerts.

**Detailed Description** [REQUIRED]
IR TickTawk helps customer support agents on the Tawk.to dashboard track visitor wait times in real time and never miss an incoming message.

Key Features:
• Live Wait Timer: Automatically starts counting from the visitor's most recent message timestamp and remembers elapsed time even when refreshing the page or switching dashboard sections.
• Pre-Alarm Chime (Default 1:45): Plays a gentle chime 15 seconds before the 2-minute mark to give agents a heads-up before a chat becomes overdue.
• Urgent Looping Alarm (Default 3:00): Sounds a repeating alert when a visitor has been waiting for 3 minutes until you send a reply or silence the alarm.
• Customizable Thresholds: Adjust both the 1st pre-alarm time and the maximum urgent alarm time directly inside the floating monitor widget.
• Automatic Reset on Reply: Clears the timer and stops any active alarm as soon as you reply to the visitor.
• Draggable & Always-on-Top Pop-Out: Drag the badge anywhere inside the dashboard, or pop it out into a small always-on-top floating window that stays visible over other apps on your desktop.

How to Use:
1. Install the extension and open https://dashboard.tawk.to/.
2. Click once on the floating TickTawk badge to enable browser audio alerts.
3. Click the gear icon on the badge at any time to customize your pre-alarm and urgent alarm durations.
4. Click the pin icon to pop the timer out into an always-on-top mini window while working across other applications.

Privacy & Security:
IR TickTawk runs entirely locally in your browser on dashboard.tawk.to. No chat messages, visitor details, or personal data are ever collected or sent to any external server.

Support & Feedback:
Report issues or request features at https://github.com/mongobread/ir-ticktawk/issues

**Category** [REQUIRED]
Productivity

**Single Purpose** [REQUIRED]
Monitors unanswered visitor chat wait times on dashboard.tawk.to and plays configurable audio alerts when a response is due.

**Primary Language** [REQUIRED]
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon [REQUIRED] | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 [REQUIRED] | 1280×800 or 640×400 | 🟡 Take from dashboard | |
| Small Promo Tile [RECOMMENDED] | 440×280 | ⬜ Optional | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Saves the agent's custom alarm time thresholds (pre-alarm and urgent alarm durations), mute preference, badge position, and active countdown timestamp locally on the user's device so the timer does not reset when refreshing the dashboard. |
| `https://dashboard.tawk.to/*` | host_permissions | Required to display the floating response timer badge on the Tawk.to agent dashboard and detect when a visitor message is waiting for an agent reply. |

## Privacy & Data Use

### Data Collection

**Does the extension collect user data?** No

### Data Use Certification
- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Privacy Policy

**Privacy Policy URL** [REQUIRED if collecting data; recommended for all listings]
https://github.com/mongobread/ir-ticktawk/blob/main/PRIVACY.md

## Distribution

**Visibility**: Public
**Regions**: All regions

## Developer Info

**Publisher Name**: Ivan Rubio (`mongobread`)
**Contact Email**: ivan@thepetlabco.com
**Support URL**: https://github.com/mongobread/ir-ticktawk/issues
**Homepage URL**: https://github.com/mongobread/ir-ticktawk

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.3.2 | 2026-11-03 | Detect unsent Live Translate previews ("The customer will see...") before resetting timer, fix background tab scanning, and eliminate same-minute :00 backdating. | Ready to Submit |
| 1.3.1 | 2026-11-03 | Ignore unjoined chats (with "Join Chat" button) and chats without agent replies; only track active ongoing chats where the agent has responded. | Archived |
| 1.3.0 | 2026-11-03 | Added 3-chat timebomb stack, « and » carousel navigation, and click-to-jump to visitor chat. | Archived |
| 1.2.1 | 2026-11-03 | Fixed bug where internal Agent DMs and Group Chats were scanned as visitor chats. | Draft |
| 1.2.0 | 2026-11-03 | Added 1:45 default pre-alarm, customizable alarm thresholds in modal, and store icons. | Draft |
| 1.1.1 | 2026-11-03 | Scoped strictly to dashboard.tawk.to, added draggable UI, PiP pop-out, and persistent timer. | Draft |
| 1.0.0 | 2026-11-03 | Initial extension build. | Draft |

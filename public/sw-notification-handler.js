/**
 * Custom service-worker logic for rest-timer notification action buttons (LIFT-751).
 *
 * The Workbox `generateSW` build has no `notificationclick` handler of its own, so
 * without this an action button on the "Rest Complete" notification would render but
 * do nothing. This script is injected into the generated SW via `workbox.importScripts`
 * (see vite.config.js) and handles the two rest-timer actions plus the default body tap:
 *
 *   - "Log Set" (`log-set`) / body tap  → focus the open app (or open it at the workouts tab)
 *   - "Rest Again" (`rest-again`)        → focus the app and restart the rest timer
 *
 * How the "rest again" intent reaches the client depends on whether a window is
 * already open, and getting that wrong made the button a no-op in its primary
 * scenario (LIFT-1355). `openWindow()` resolves as soon as the WindowClient is
 * created — long before the page's JS runs — so posting a message to a client we
 * just opened lands in a document with no listener and is dropped. iOS kills
 * backgrounded PWAs, so "phone locked, tap Rest Again" is exactly that case. The
 * two channels are therefore split:
 *
 *   - a window is already open → `postMessage` it and focus it (it is booted, and
 *     changing its URL would mean `client.navigate()`, i.e. a reload that throws
 *     away the in-progress workout)
 *   - no window            → encode the action in the launch URL; the client
 *                            consumes and strips it on boot (`restTimerIntent.ts`)
 *
 * It intentionally scopes itself to the `lift-rest-timer` tag so unrelated future
 * notifications are left to their own handling.
 */
/* global self, clients */

self.addEventListener('notificationclick', (event) => {
  const notification = event.notification
  if (notification.tag !== 'lift-rest-timer') return

  const action = event.action
  notification.close()

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // Prefer an already-open window so we land back on the workout in progress.
      // That client is booted, so postMessage reaches a live listener.
      const openClient = windowClients.find((c) => 'focus' in c) || null
      if (openClient) {
        // Message BEFORE focusing, and never let a refused focus escape: focus()
        // rejects on a user agent that declines the activation, and delivering
        // the action must not depend on it — a silently-dropped intent is the
        // entire defect this handler had. Losing the foreground is recoverable
        // (the user is looking at the notification); losing the rest is not.
        if (action === 'rest-again') {
          openClient.postMessage({ type: 'rest-timer-action', action: 'rest-again' })
        }
        try {
          await openClient.focus()
        } catch { /* focus refused — the action has already been delivered */ }
        return
      }

      // Nothing open: the intent has to survive a full cold boot, so it travels in
      // the URL rather than in a message the booting document cannot hear yet.
      if (self.clients.openWindow) {
        await self.clients.openWindow(
          action === 'rest-again' ? '/?tab=workouts&action=rest-again' : '/?tab=workouts',
        )
      }
    })(),
  )
})

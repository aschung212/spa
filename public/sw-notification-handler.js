/**
 * Custom service-worker logic for rest-timer notification action buttons (LIFT-751).
 *
 * The Workbox `generateSW` build has no `notificationclick` handler of its own, so
 * without this an action button on the "Rest Complete" notification would render but
 * do nothing. This script is injected into the generated SW via `workbox.importScripts`
 * (see vite.config.js) and handles the two rest-timer actions plus the default body tap:
 *
 *   - "Log Set" (`log-set`) / body tap  → focus the open app (or open it at the workouts tab)
 *   - "Rest Again" (`rest-again`)        → focus the app and hand it the action so it can
 *                                          start another rest
 *
 * HOW THE ACTION REACHES THE CLIENT DEPENDS ON WHETHER ONE IS ALREADY RUNNING (LIFT-1355).
 * An existing window is executing its own JS, so `postMessage` lands on a live listener.
 * A window we have to OPEN is not: `openWindow()` resolves as soon as the client is
 * created, long before its scripts run, so a message posted here is delivered into a page
 * with no listener yet and is silently dropped. That is the PRIMARY case for this feature
 * — iOS reclaims backgrounded PWAs, so a user tapping "Rest Again" after their phone
 * locked is exactly the user who is starting the app cold. The action therefore travels
 * in the launch URL, which the client reads and clears on boot.
 *
 * `ACTION_PARAM`/`REST_AGAIN` are kept in lockstep with `REST_TIMER_ACTION_PARAM` /
 * `REST_AGAIN_ACTION` in src/composables/useRestTimerIntent.ts. This file is a classic
 * script pulled in by `importScripts`, so it cannot import them; restTimerNotificationHandler
 * .test.ts drives this handler against those constants so the two halves cannot drift.
 *
 * It intentionally scopes itself to the `lift-rest-timer` tag so unrelated future
 * notifications are left to their own handling.
 */
/* global self */

const ACTION_PARAM = 'rest-action'
const REST_AGAIN = 'rest-again'
const APP_URL = '/?tab=workouts'

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

      // Prefer focusing an already-open window so we land back on the workout in
      // progress — and, being booted, it can take the action by message.
      const existing = windowClients.find((c) => 'focus' in c) || null
      if (existing) {
        await existing.focus()
        if (action === REST_AGAIN) {
          existing.postMessage({ type: 'rest-timer-action', action: REST_AGAIN })
        }
        return
      }

      if (!self.clients.openWindow) return
      // Nothing to message — carry the action in the URL the new client boots with.
      await self.clients.openWindow(
        action === REST_AGAIN ? `${APP_URL}&${ACTION_PARAM}=${REST_AGAIN}` : APP_URL,
      )
    })(),
  )
})

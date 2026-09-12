<template>
  <ErrorBoundary>
  <div id="appShell">
    <!-- Nothing renders while loading — splash screen covers this -->
    <template v-if="!loading">

    <!-- Auth screen -->
    <AuthScreen v-if="!user" />

    <!-- Onboarding -->
    <OnboardingScreen v-else-if="showOnboarding" @complete="completeOnboarding" @started="onboardingInProgress = true" />

    <!-- Authenticated app -->
    <template v-else>
      <a href="#main-content" class="srOnly srOnlyFocusable">Skip to content</a>
      <main class="appContainer">
        <div v-if="isPreviewDeploy" class="previewBanner" role="status">
          <template v-if="isPreviewMode">
            Preview mode — changes stay local
            <button class="previewToggle" @click="isPreviewMode = false">Enable writes</button>
          </template>
          <template v-else>
            ⚠ Live writes enabled — changes sync to Supabase
            <button class="previewToggle" @click="isPreviewMode = true">Go read-only</button>
          </template>
        </div>
        <div v-if="authNeedsReauth" class="previewBanner" role="status">
          Session expired — sign in again to resume syncing
          <button class="previewToggle" @click="handleSignOut">Sign in</button>
        </div>
        <button v-if="hasSampleData" class="sampleBanner" @click="clearSampleData">
          Viewing sample data — Tap to clear and start fresh
        </button>

        <div v-if="showGuestBackupPrompt" class="guestBackupBanner" role="status">
          <span class="guestBackupText">Your workouts are saved on this device only.</span>
          <button class="guestBackupCta" @click="createAccountFromGuest">Create account</button>
          <button class="guestBackupDismiss" @click="dismissGuestBackupPrompt" aria-label="Dismiss">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div v-if="showWelcomeBack" class="welcomeBackBanner" role="status">
          <div class="welcomeBackText">
            <strong class="welcomeBackTitle">Welcome back 👋</strong>
            <span class="welcomeBackDesc">{{ welcomeBackMessage }}</span>
          </div>
          <button class="welcomeBackCta" @click="logFromWelcomeBack">Log today</button>
          <button class="welcomeBackDismiss" @click="dismissWelcomeBack" aria-label="Dismiss">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <!-- PWA install banner -->
        <Transition name="installBanner">
          <div v-if="installBannerVisible" class="installBanner" role="banner">
            <div class="installBannerContent">
              <div class="installBannerText">
                <strong class="installBannerTitle">Install Lift</strong>
                <span v-if="isIOSPrompt" class="installBannerDesc">
                  Tap
                  <svg class="installBannerShareIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-label="Share icon"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
                  then "Add to Home Screen"
                </span>
                <span v-else class="installBannerDesc">Add to your home screen for the full experience</span>
              </div>
              <div class="installBannerActions">
                <button v-if="!isIOSPrompt" class="installBannerBtn installBannerInstall" @click="triggerInstall">Install</button>
                <button class="installBannerBtn installBannerDismiss" @click="dismissInstallBanner" aria-label="Dismiss install banner">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            </div>
          </div>
        </Transition>

        <div class="appTopBar">
          <div class="appTopBarLeft">
            <button
              class="settingsGearBtn"
              @click="settingsOpen ? closeSettings() : (settingsOpen = true)"
              title="Settings"
              aria-label="Settings"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
            <span v-if="displaySyncStatus !== 'synced'" class="syncIndicator" :class="'syncIndicator--' + displaySyncStatus" :title="syncStatusLabel" role="img" :aria-label="syncStatusLabel">
              <svg v-if="displaySyncStatus === 'error'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <svg v-else-if="displaySyncStatus === 'offline'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.56 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>
              <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
            </span>
          </div>
          <div class="appTopBarRight">
            <button
              v-if="activeTab === 'workouts'"
              class="topBarPlusBtn"
              @click="triggerAddExercise"
              title="Add exercise"
              aria-label="Add exercise"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </button>
            <button
              v-if="activeTab === 'calendar' && showCoachBtn"
              class="topBarCoachBtn"
              @click="coachOpen = true"
              title="AI Review"
              aria-label="Open AI Review"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v2M12 19v2M5 12H3M21 12h-2M6.3 6.3 4.9 4.9M19.1 19.1l-1.4-1.4M17.7 6.3l1.4-1.4M4.9 19.1l1.4-1.4"/><circle cx="12" cy="12" r="4"/></svg>
            </button>
          </div>
        </div>
        <div
          id="main-content"
          ref="tabContentEl"
          class="tabContent"
          tabindex="-1"
          role="tabpanel"
          :aria-labelledby="`tab-${activeTab}`"
        >
          <KeepAlive>
            <WorkoutTracker v-if="activeTab === 'workouts'" ref="workoutTrackerRef" />
            <CalendarView v-else-if="activeTab === 'calendar'" @create-exercise="addExerciseFromCalendar" />
            <BodyweightTracker v-else-if="activeTab === 'weight'" />
          </KeepAlive>
        </div>
      </main>

      <!-- Polite SPA view-change announcement for screen readers (WCAG 4.1.3).
           switchTab swaps panel content via v-if with no native focus/route
           change, so assistive tech would otherwise stay silent. -->
      <div class="srOnly" role="status" aria-live="polite" aria-atomic="true">{{ viewAnnouncement }}</div>

      <!-- Polite sync/connectivity announcement for screen readers (LIFT-1149,
           WCAG 4.1.3). The visual syncIndicator is icon-only, so assistive tech
           would otherwise never hear the app drop offline or a sync fail. -->
      <div class="srOnly" role="status" aria-live="polite" aria-atomic="true">{{ syncAnnouncement }}</div>

      <!-- Tab bar -->
      <nav class="tabBar" aria-label="Main navigation">
        <div class="tabBarTabs" role="tablist" aria-label="Main navigation">
          <div
            class="tabIndicator"
            :style="tabIndicatorStyle"
            aria-hidden="true"
          ></div>
          <button
            v-for="tab in visibleTabs"
            :key="tab.id"
            :id="`tab-${tab.id}`"
            role="tab"
            :aria-selected="activeTab === tab.id"
            aria-controls="main-content"
            :tabindex="activeTab === tab.id ? 0 : -1"
            :class="['tabBtn', { active: activeTab === tab.id }]"
            @click="switchTab(tab.id)"
            @keydown="onTablistKeydown"
          >
            <!-- eslint-disable-next-line vue/no-v-html, vue/html-self-closing -- icons are hardcoded SVG paths, not user input -->
            <svg class="tabIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" v-html="tab.icon"></svg>
            <span class="tabLabel">{{ tab.label }}</span>
          </button>
        </div>
      </nav>

      <!-- Settings bottom sheet (extracted to SettingsSheet.vue) -->
      <SettingsSheet v-if="settingsOpen" ref="settingsSheetRef" v-model="settingsOpen" @sign-out="handleSignOut" />

      <!-- AI Review sheet (entry: Calendar-tab top-bar button) -->
      <CoachSheet v-if="coachOpen" @close="coachOpen = false" />
    </template>

    <!-- Undo toast -->
    <Teleport to="body">
      <Transition name="undoToast">
        <div v-if="undoToast" class="undoToastBar" role="status" aria-live="polite">
          <span class="undoToastMsg">{{ undoToast.message }}</span>
          <button class="undoToastBtn" @click="performUndo">Undo</button>
        </div>
      </Transition>
    </Teleport>

    <!-- Keyboard shortcuts help -->
    <Teleport to="body">
      <Transition name="undoToast">
        <div v-if="shortcutsOpen" class="kbOverlay" @click.self="closeShortcuts" @keydown.escape="closeShortcuts">
          <div class="kbSheet" role="dialog" aria-modal="true" aria-labelledby="kb-title">
            <h3 id="kb-title" class="kbTitle">Keyboard Shortcuts</h3>
            <dl class="kbList">
              <div class="kbRow"><dt class="kbKey"><kbd>?</kbd></dt><dd class="kbDesc">Show this help</dd></div>
              <div class="kbRow"><dt class="kbKey"><kbd>1</kbd></dt><dd class="kbDesc">Go to Workouts</dd></div>
              <div class="kbRow"><dt class="kbKey"><kbd>2</kbd></dt><dd class="kbDesc">Go to Calendar</dd></div>
              <div class="kbRow"><dt class="kbKey"><kbd>3</kbd></dt><dd class="kbDesc">Go to Weight</dd></div>
              <div class="kbRow"><dt class="kbKey"><kbd>,</kbd></dt><dd class="kbDesc">Open settings</dd></div>
              <div class="kbRow"><dt class="kbKey"><kbd>Esc</kbd></dt><dd class="kbDesc">Close panel</dd></div>
            </dl>
            <button class="kbClose" @click="closeShortcuts">Close</button>
          </div>
        </div>
      </Transition>
    </Teleport>

    </template>
  </div>
  </ErrorBoundary>

  <!-- Global XP toast -->
  <Teleport to="body">
    <transition name="xpGlobalFade">
      <div v-if="xpToast.visible" class="xpGlobalToast" role="status" aria-live="polite">
        <div class="xpToastEarned">{{ xpToast.text }}</div>
        <div class="xpToastTotal">{{ xpToast.nextThresholdXP ? `${xpToast.totalXP.toLocaleString()} / ${xpToast.nextThresholdXP.toLocaleString()} XP` : `${xpToast.totalXP.toLocaleString()} XP` }}</div>
        <div
          v-if="xpToast.nextThresholdXP"
          class="xpToastProgress"
          role="progressbar"
          aria-label="XP progress to next level"
          aria-valuemin="0"
          aria-valuemax="100"
          :aria-valuenow="xpToast.progressPercent"
          :aria-valuetext="`${xpToast.totalXP.toLocaleString()} of ${xpToast.nextThresholdXP.toLocaleString()} XP`"
        >
          <div class="xpToastProgressFill" :style="{ width: xpToast.progressPercent + '%' }"></div>
        </div>
      </div>
    </transition>
  </Teleport>


  <!-- Theme unlock celebration -->
  <Teleport to="body">
    <transition name="unlockFade">
      <div v-if="unlockCelebration.visible" class="unlockOverlay" @click.self="dismissUnlockCelebration">
        <div class="unlockModal" role="alert" aria-live="assertive">
          <div class="unlockIcon">
            <span
              class="unlockDot"
              :style="unlockCelebration.themeId ? {
                background: 'linear-gradient(135deg, ' + THEME_PREVIEWS[unlockCelebration.themeId]?.[resolvedMode]?.accent + ', ' + THEME_PREVIEWS[unlockCelebration.themeId]?.[resolvedMode]?.bg + ')',
              } : {}"
            ></span>
          </div>
          <div class="unlockTitle">{{ progressionStore.showProgression ? 'Theme Unlocked!' : 'New Theme Available!' }}</div>
          <div class="unlockThemeName">{{ unlockCelebration.themeName }}</div>
          <button class="unlockDismiss" @click="dismissUnlockCelebration">Nice!</button>
        </div>
      </div>
    </transition>
  </Teleport>

  <!-- Full-screen PR celebration — triggered via usePRBurst().presentPRBurst(). -->
  <Teleport to="body">
    <PRBurst />
  </Teleport>

  <!-- First-set activation celebration (#762) — triggered on a new user's first
       ever logged set via useFirstSetCelebration().presentFirstSetCelebration(). -->
  <Teleport to="body">
    <FirstSetCelebration />
  </Teleport>

  <!-- Weekly-goal celebration — triggered via useGoalCelebration().presentGoalCelebration(). -->
  <Teleport to="body">
    <GoalCelebration />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { isPreviewDeploy, isPreviewMode, initSupabase } from './lib/supabase'
import ErrorBoundary from './components/ErrorBoundary.vue'
import AuthScreen from './views/AuthScreen.vue'
import OnboardingScreen from './views/OnboardingScreen.vue'
import PRBurst from './components/PRBurst.vue'
import FirstSetCelebration from './components/FirstSetCelebration.vue'
import GoalCelebration from './components/GoalCelebration.vue'

// Lazy-load tab content — split into separate chunks for faster initial load
import SkeletonLoader from './components/SkeletonLoader.vue'
const WorkoutTracker = defineAsyncComponent({
  loader: () => import('./components/WorkoutTracker.vue'),
  loadingComponent: SkeletonLoader,
  delay: 100,
})
const CalendarView = defineAsyncComponent({
  loader: () => import('./views/CalendarView.vue'),
  loadingComponent: SkeletonLoader,
  delay: 100,
})
const BodyweightTracker = defineAsyncComponent({
  loader: () => import('./views/BodyweightTracker.vue'),
  loadingComponent: SkeletonLoader,
  delay: 100,
})
// Settings is reachable only behind a tap and pulls in training-report/data-export
// UI many users never open — split it (and its transitive deps) into an on-demand
// chunk, gated by v-if="settingsOpen" so the chunk isn't fetched until first open.
const SettingsSheet = defineAsyncComponent(() => import('./components/SettingsSheet.vue'))
// AI Review sheet — reached only from the Calendar-tab top-bar button, so its
// chunk (and the export/profile UI it pulls in) loads on first open.
const CoachSheet = defineAsyncComponent(() => import('./views/CoachSheet.vue'))
import { coachReviewEligibility } from './lib/coachDigest'
import { COACH_MODE } from './lib/coachExport'
import { useTheme, connectProgressionStore, connectThemeStore } from './composables/useTheme'
import type { ThemeId } from './lib/themes'
import { useProgressionStore } from './stores/progression'
import { xpToast, unlockCelebration, dismissUnlockCelebration, showXPToast } from './composables/xpCeremonyUI'
import { useXPCeremony } from './composables/useXPCeremony'
import { isMigrated, markMigrated, computeRetroactiveXP } from './lib/xpMigration'
import { requestPersistentStorage, ensureLocalStorage } from './lib/durableStorage'
import { guardedReload } from './lib/reloadGuard'
import { useAuth } from './composables/useAuth'
import { useAnalytics } from './composables/useAnalytics'
import { captureAcquisitionSource } from './composables/useAcquisitionSource'
import { usePreferencesStore } from './stores/preferences'
import { useWorkoutStore } from './stores/workout'
import { syncStatus } from './lib/syncQueue'
import { combineSyncStatus } from './lib/syncStatus'
import { authNeedsReauth } from './lib/sessionHealth'
import { useBodyweightStore } from './stores/bodyweight'
import { useUndoToast } from './composables/useUndoToast'
import { useFocusTrap } from './composables/useFocusTrap'
import { useKeyboardShortcuts } from './composables/useKeyboardShortcuts'
import { useInstallPrompt } from './composables/useInstallPrompt'
import { usePRBurst } from './composables/usePRBurst'
import { useServiceWorker } from './composables/useServiceWorker'
import { setupSyncRecovery } from './composables/useSyncRecovery'
import { useAppBadge } from './composables/useAppBadge'
import { todayISO } from './lib/dates'
import { useOnboarding } from './composables/useOnboarding'
import { useTabRouting } from './composables/useTabRouting'
import { useRestTimer } from './composables/useRestTimer'
import { takeRestTimerLaunchAction, useRestTimerIntent, REST_AGAIN_ACTION } from './composables/useRestTimerIntent'
import { onCrossTabMessage, type StoreKey } from './lib/crossTabSync'
import { GUEST_BACKUP_PROMPT_DISMISSED_KEY } from './composables/useAuth'
import { decideWelcomeBack, readWelcomeBackState, markWelcomedBack, type WelcomeBackDecision } from './lib/welcomeBack'

const { currentTheme, THEME_PREVIEWS, resolvedMode, isThemeUnlocked } = useTheme()
// The preferences store is the single source of truth for theme/colorMode
// (LIFT-1177); drive DOM application from it so cross-tab and Supabase updates
// are always reflected. Idempotent — the connect is guarded against re-runs.
connectThemeStore()

const progressionStore = useProgressionStore()
connectProgressionStore(() => progressionStore)
const { celebrateUnlocks } = useXPCeremony()

const { user, loading, isGuest, init: initAuth, signOut, exitGuestMode } = useAuth()
const { logEvent, tabSwitch, flushEngagement } = useAnalytics()
const prefs = usePreferencesStore()
const { toast: undoToast, performUndo } = useUndoToast()

// Acquire each store once and pass references to the lifecycle composables and
// handlers below — Pinia returns the same instance per call, so re-calling the
// hooks in scattered handlers was redundant noise.
const workoutStore = useWorkoutStore()
const bodyweightStore = useBodyweightStore()

// ── PWA install prompt ──────────────────────────────────────────
const installWorkoutDays = computed(() => workoutStore.workoutDates.length)
const { showBanner: installBannerVisible, isIOSPrompt, dismiss: dismissInstallBanner, install: triggerInstall, surfaceAtPeakMoment: surfaceInstallAtPeak } = useInstallPrompt(installWorkoutDays, logEvent)

// Re-surface the install prompt at a peak moment: once a PR celebration is
// dismissed, the user is at a high point of engagement — a far better time to
// ask than the raw 3-workout-day gate (#1060). Respects install/snooze state.
const { visible: prBurstVisible } = usePRBurst()
watch(prBurstVisible, (visible, wasVisible) => {
  if (wasVisible && !visible) surfaceInstallAtPeak()
})

// ── Unfinished-workout app-icon badge ───────────────────────────
// When the user backgrounds the app with sets logged today, badge the
// Home-Screen icon with that count so they're nudged back to finish — and
// clear it the moment they return. No-ops where the Badging API is
// unsupported (see useAppBadge). Mirrors WorkoutTracker's `setsLoggedToday`,
// which drives the in-app "Finish workout" affordance.
const { setBadge: setAppBadge, clearBadge: clearAppBadge } = useAppBadge()
// Plain function (not a computed) so `todayISO()` is re-evaluated every time the
// app is backgrounded — a cached computed would badge yesterday's count after a
// midnight rollover with no new sets to invalidate it.
//
// Delegates to the store's sets-per-day index (LIFT-1237) instead of rescanning
// every set. That also puts the badge on `setDayKey` bucketing: this scan used
// raw `toLocalDateKey`, which shifts a UI-logged set's `…T23:59Z` stamp forward
// a day for every user east of UTC (#746), so the badge counted tomorrow's
// bucket and showed 0 mid-session in those timezones.
function countSetsLoggedToday(): number {
  return workoutStore.setsLoggedOn(todayISO())
}
function onBadgeVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    const count = countSetsLoggedToday()
    if (count > 0) setAppBadge(count)
    else clearAppBadge()
  } else {
    // Back in the foreground — the nudge has served its purpose.
    clearAppBadge()
  }
}

// Dismiss splash screen once auth resolves
watch(loading, (isLoading) => {
  if (!isLoading) {
    const splash = document.getElementById('splash')
    if (splash) {
      splash.classList.add('fade-out')
      splash.addEventListener('transitionend', () => splash.remove())
    }
  }
}, { immediate: true })

// A background READ fetch failure is recorded on each store's `lastSyncError`
// (LIFT-820) but the indicator used to reflect only the write queue, so a silent
// read failure (RLS regression, expired token, offline first-load) still showed
// 'synced'. Fold the four stores' read errors into the displayed status
// (LIFT-1179) — first non-null wins; the value only matters as present/absent.
const readSyncError = computed(() =>
  workoutStore.lastSyncError
  ?? bodyweightStore.lastSyncError
  ?? progressionStore.lastSyncError
  ?? prefs.lastSyncError
  ?? null,
)
const displaySyncStatus = computed(() => combineSyncStatus(syncStatus.value, readSyncError.value))

const syncStatusLabel = computed(() => {
  if (displaySyncStatus.value === 'syncing') return 'Syncing...'
  if (displaySyncStatus.value === 'error') return 'Sync failed — changes saved locally'
  if (displaySyncStatus.value === 'offline') return 'Offline — changes saved locally'
  return ''
})

// Detect offline/online
function updateOnlineStatus() {
  if (!navigator.onLine) syncStatus.value = 'offline'
  else if (syncStatus.value === 'offline') syncStatus.value = 'synced'
}
// Registration lives in onMounted/onUnmounted alongside every other listener
// this component owns (LIFT-1240) — registering in the setup body left a
// permanent pair of window listeners holding this instance's reactive scope,
// so an unmounted instance kept mutating the module-level `syncStatus`.
// The initial read stays here so the first paint reflects connectivity — and,
// because `syncStatus` is module state, so a remount can't inherit a stale
// 'offline' from a previous instance.
updateOnlineStatus()

const settingsOpen = ref(false)
// SettingsSheet is an async component, so a `typeof`-based InstanceType would
// resolve to the loader wrapper, not the SFC. It only exposes closeSettings(),
// so type the ref by the exposed surface we actually call.
const settingsSheetRef = ref<{ closeSettings: () => void } | null>(null)

// ── AI Review entry (#972) ──────────────────────────────────────
// Lives in the top bar on the Calendar tab (mirroring the contextual "+" on
// Workouts) rather than as a card on the Workouts page: it's an infrequent,
// retrospective feature, so it gets a compact nav-bar affordance on the
// retrospective surface. Gate: enough training signal (a couple weeks + the
// set floor), not a preview deploy, and — server transport only — a signed-in
// user; the BYO export is 100% local, so it needs no account.
const coachOpen = ref(false)
const coachEligible = computed(
  () => coachReviewEligibility(workoutStore.exercises, new Date()).eligible,
)
const showCoachBtn = computed(
  () =>
    coachEligible.value &&
    !isPreviewMode.value &&
    (COACH_MODE === 'byo' || user.value !== null),
)

// ── Focus traps for modals ─────────────────────────────────────
const shortcutsFocus = useFocusTrap()

// ── Service worker auto-update ──────────────────────────────────
// Registration is skipped entirely on the native Capacitor build (#532);
// see useServiceWorker for the rationale.
const { checkForSWUpdate } = useServiceWorker()

// ── Onboarding ──────────────────────────────────────────────────
const {
  showOnboarding,
  onboardingInProgress,
  hasSampleData,
  completeOnboarding,
  clearSampleData,
  resetOnboarding,
} = useOnboarding({ workoutStore, bodyweightStore })

function closeSettings() {
  const sheet = settingsSheetRef.value
  // The sheet runs its own exit animation before emitting the close — but it can
  // only do that if it actually mounted. SettingsSheet is an async component, so
  // the ref is still null while its chunk is in flight and stays null forever if
  // that chunk fails to resolve (offline, or a stale hash after a deploy). The
  // bare `?.` here meant `settingsOpen` stayed true with nothing rendered, and
  // since the gear reads `settingsOpen ? closeSettings() : (settingsOpen = true)`
  // it could never reach the open branch again — settings was dead until reload.
  if (sheet) sheet.closeSettings()
  else settingsOpen.value = false
}

// ── Sign out handler (from SettingsSheet) ────────────────────────
function handleSignOut() {
  // A guest has no server account — "signing out" just returns them to the
  // auth screen so they can create one. Preserve local data (no resetStores)
  // so signing up migrates their existing workouts (LIFT-1083).
  if (isGuest.value) {
    exitGuestMode()
    return
  }
  resetOnboarding()
  signOut()
}

// ── Guest "create an account to back up" nudge (LIFT-1083) ───────
// Surfaced only once a guest has real (non-sample) workout data — the point at
// which they have something worth losing. Dismissal persists so it doesn't nag.
const guestPromptDismissed = ref(localStorage.getItem(GUEST_BACKUP_PROMPT_DISMISSED_KEY) === 'true')
const showGuestBackupPrompt = computed(() =>
  isGuest.value &&
  !hasSampleData.value &&
  !guestPromptDismissed.value &&
  workoutStore.workoutDates.length > 0,
)
function createAccountFromGuest() {
  logEvent('guest_create_account_tap')
  exitGuestMode()
}
function dismissGuestBackupPrompt() {
  guestPromptDismissed.value = true
  localStorage.setItem(GUEST_BACKUP_PROMPT_DISMISSED_KEY, 'true')
  logEvent('guest_backup_prompt_dismissed')
}

// ── Welcome-back re-entry moment (LIFT-1107) ─────────────────────
// A lapsed user (≥14 days since their last workout) returns to a warm,
// data-safe acknowledgement instead of a cold normal state. Evaluated once on
// mount (workoutDates hydrates synchronously from localStorage); the decision
// is device-local and keyed on the last-workout date so it shows once per
// absence and re-arms only after a fresh workout is logged. Suppressed while
// sample/onboarding data is present so a first-run user is never "welcomed back".
const welcomeBack = ref<WelcomeBackDecision | null>(null)
const showWelcomeBack = computed(() => welcomeBack.value !== null && !hasSampleData.value)
const welcomeBackMessage = computed(() => {
  const d = welcomeBack.value
  if (!d) return ''
  const weeks = Math.floor(d.daysAway / 7)
  const gap = weeks >= 2 ? `${weeks} weeks` : `${d.daysAway} days`
  return `It's been ${gap} since your last workout — your progress is all still here. Pick up right where you left off.`
})
function evaluateWelcomeBack() {
  const state = readWelcomeBackState()
  const decision = decideWelcomeBack(workoutStore.workoutDates, state.acknowledgedWorkoutDate)
  welcomeBack.value = decision
  if (decision) logEvent('welcome_back_impression', { days_away: decision.daysAway })
}
function acknowledgeWelcomeBack() {
  if (welcomeBack.value) markWelcomedBack(welcomeBack.value.lastWorkoutDate)
  welcomeBack.value = null
}
function dismissWelcomeBack() {
  logEvent('welcome_back_dismissed')
  acknowledgeWelcomeBack()
}
function logFromWelcomeBack() {
  logEvent('welcome_back_log_tap')
  acknowledgeWelcomeBack()
  switchTab('workouts')
}

// ── Acquisition attribution ─────────────────────────────────────
// Capture the inbound ?ref= / ?utm_*= source once, before the ?tab= cleanup
// below strips the query string. Logs a single acquisition_source event and
// remembers it so launch channels (Product Hunt, Reddit, link-in-bio) are
// measurable without a backend.
captureAcquisitionSource()

// ── Rest-timer notification action (LIFT-1355) ──────────────────
// A "Rest Again" tap that had to cold-start the app carries its action in the
// launch URL, because the service worker has no booted client to postMessage.
// Read (and clear) it HERE, before the ?tab= cleanup below wipes the whole query
// string — the intent is acted on from onMounted, once switchTab exists.
const launchRestAction = takeRestTimerLaunchAction()

// ── Tab routing (supports PWA manifest shortcuts via ?tab= param) ─────
// The scrollable tab-content element, used to preserve per-tab scroll offset.
const tabContentEl = ref<HTMLElement | null>(null)
const { activeTab, switchTab } = useTabRouting({
  scrollContainer: tabContentEl,
  // Runs on every tap (including the active tab) — dismiss the settings sheet.
  onBeforeSwitch: closeSettings,
  onSwitch: (from, to) => {
    // Announce the newly shown view to assistive tech (LIFT-854, WCAG 4.1.3) —
    // the panel content swaps via v-if with no native focus move, so screen
    // readers would otherwise hear nothing.
    const label = TAB_DEFS.find(t => t.id === to)?.label ?? to
    viewAnnouncement.value = `${label} view`
    tabSwitch(from, to)
    checkForSWUpdate()
  },
})

// ── Keyboard shortcuts ─────────────────────────────────────────────
const { helpOpen: shortcutsOpen, toggleHelp: toggleShortcuts, closeHelp: closeShortcuts } = useKeyboardShortcuts(() => [
  { key: '?', label: 'Show keyboard shortcuts', action: toggleShortcuts },
  { key: '1', label: 'Go to Workouts', action: () => switchTab('workouts') },
  { key: '2', label: 'Go to Calendar', action: () => switchTab('calendar') },
  { key: '3', label: 'Go to Weight', action: () => switchTab('weight') },
  { key: ',', label: 'Open settings', action: () => { settingsOpen.value = true } },
  { key: 'Escape', label: 'Close panel', action: () => { closeSettings(); closeShortcuts() }, global: true },
])

// ── Focus trap watches for v-if modals ─────────────────────────
watch(shortcutsOpen, async (open) => {
  if (open) {
    await nextTick()
    const el = document.querySelector<HTMLElement>('.kbSheet')
    if (el) shortcutsFocus.activate(el)
  } else {
    shortcutsFocus.deactivate()
  }
})

// ── Tab definitions with inline SVG paths ────────────────────────
const TAB_DEFS = [
  {
    id: 'workouts',
    label: 'Workouts',
    icon: '<rect x="2" y="10" width="4" height="4" rx="1"/><rect x="18" y="10" width="4" height="4" rx="1"/><rect x="5" y="8" width="3" height="8" rx="1"/><rect x="16" y="8" width="3" height="8" rx="1"/><line x1="8" y1="12" x2="16" y2="12"/>',
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="16" y1="2" x2="16" y2="6"/><circle cx="8" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="14" r="1" fill="currentColor" stroke="none"/>',
  },
  {
    id: 'weight',
    label: 'Weight',
    icon: '<path d="M12 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/><path d="M5 21h14"/><path d="M6 21l1.5-8h9L18 21"/><line x1="12" y1="9" x2="12" y2="13"/>',
  },
]

const visibleTabs = computed(() =>
  TAB_DEFS.filter(t => prefs.features[t.id])
)

const tabIndicatorStyle = computed(() => {
  const idx = visibleTabs.value.findIndex(t => t.id === activeTab.value)
  const count = visibleTabs.value.length
  if (idx < 0 || count === 0) return { opacity: 0 }
  const widthPct = 100 / count
  return {
    width: `calc(${widthPct}% - 8px)`,
    left: `calc(${widthPct * idx}% + 4px)`,
  }
})

// Fall back if active tab gets disabled
watch(() => prefs.features, () => {
  if (!prefs.features[activeTab.value]) {
    switchTab(visibleTabs.value[0]?.id || 'workouts')
  }
}, { deep: true })

// Polite live-region text announcing the active view after a tab switch.
const viewAnnouncement = ref('')

// Polite live-region text announcing sync/connectivity changes (LIFT-1149).
// The visual syncIndicator is icon-only and its :title is not reliably surfaced
// by VoiceOver, so screen-reader users would otherwise get no notice when the
// app drops offline or a sync fails. Transient 'syncing' is deliberately not
// announced (it fires on every batch and would be noise); recovery to 'synced'
// is announced only when coming back from an offline/error state.
const syncAnnouncement = ref('')
watch(displaySyncStatus, (status, prev) => {
  if (status === 'offline' || status === 'error') {
    syncAnnouncement.value = syncStatusLabel.value
  } else if (status === 'synced' && (prev === 'offline' || prev === 'error')) {
    syncAnnouncement.value = 'Back online — changes synced'
  } else {
    syncAnnouncement.value = ''
  }
})

// Roving-tabindex keyboard navigation for the bottom tablist (ARIA APG Tabs
// pattern, automatic-activation variant). Arrow/Home/End move focus between
// tabs and activate the focused one; the active tab is the only one in the
// tab order (tabindex 0), the rest are -1.
function onTablistKeydown(e: KeyboardEvent) {
  const tabs = visibleTabs.value
  const currentIdx = tabs.findIndex(t => t.id === activeTab.value)
  if (currentIdx < 0 || tabs.length === 0) return
  let nextIdx: number
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      nextIdx = (currentIdx + 1) % tabs.length
      break
    case 'ArrowLeft':
    case 'ArrowUp':
      nextIdx = (currentIdx - 1 + tabs.length) % tabs.length
      break
    case 'Home':
      nextIdx = 0
      break
    case 'End':
      nextIdx = tabs.length - 1
      break
    default:
      return
  }
  e.preventDefault()
  const nextTab = tabs[nextIdx]
  switchTab(nextTab.id)
  nextTick(() => {
    document.getElementById(`tab-${nextTab.id}`)?.focus()
  })
}

// Exposed from WorkoutTracker via defineExpose so the top-bar "+" can open the
// new-exercise modal directly. Logging a set is a per-exercise action (the "+"
// on each exercise row); the top-bar "+" is reserved for adding an exercise.
const workoutTrackerRef = ref<InstanceType<typeof WorkoutTracker> | null>(null)

function triggerAddExercise() {
  const wt = workoutTrackerRef.value
  if (wt && typeof wt.openNewExerciseModal === 'function') {
    wt.openNewExerciseModal()
    return true
  }
  return false
}

/**
 * "+ New exercise" from the Calendar tab's backfill picker (LIFT-1375). The
 * calendar deliberately owns no creation form of its own, so the intent is
 * carried to the one that exists.
 *
 * The intent is PARKED rather than fired straight at the ref: the top-bar "+"
 * can assume WorkoutTracker is mounted (it only renders on that tab), but this
 * caller cannot — WorkoutTracker is an async component, so on a cold start
 * straight into `?tab=calendar` its chunk is still loading when the tab flips
 * and `workoutTrackerRef` is null for more than a tick. The template ref is
 * reactive, so the watcher below flushes the intent whenever it does land.
 *
 * The switch is unconditional even when the Workouts tab is disabled in
 * preferences: that user has no exercise-creation surface at all (the top-bar
 * "+" only renders on that tab), so honouring the tap is the only thing that
 * helps, and the tab bar still holds their escape route — the same thing the
 * "Go to Workouts" keyboard shortcut already does.
 */
const pendingAddExercise = ref(false)

function addExerciseFromCalendar() {
  pendingAddExercise.value = true
  switchTab('workouts')
  flushPendingAddExercise()
}

function flushPendingAddExercise() {
  if (!pendingAddExercise.value) return
  if (triggerAddExercise()) pendingAddExercise.value = false
}

/**
 * "Rest Again" from the rest-complete notification (LIFT-1355).
 *
 * Same parked-intent shape as the calendar handoff above, and for a sharper
 * version of the same reason: the request arrives from the service worker, which
 * has no way to know whether a listener exists yet. It used to be consumed inside
 * `useRestTimerController` — i.e. only once WorkoutTracker's async chunk had
 * loaded and mounted — so on a cold start (the case iOS makes the common one) it
 * landed on nothing at all. `start()` reports whether the controller was there to
 * take it; the watcher below retries when the chunk lands.
 */
const { restTimerEnabled } = useRestTimer()
const restTimerIntent = useRestTimerIntent({
  isEnabled: () => restTimerEnabled.value,
  reveal: () => switchTab('workouts'),
  start: () => {
    const ctrl = workoutTrackerRef.value?.timerCtrl
    if (typeof ctrl?.startRestTimer !== 'function') return false
    ctrl.startRestTimer()
    return true
  },
})

watch(workoutTrackerRef, () => {
  flushPendingAddExercise()
  restTimerIntent.flush()
})

// Flush engagement timing on page unload
function onBeforeUnload() {
  flushEngagement()
}

onMounted(async () => {
  window.addEventListener('beforeunload', onBeforeUnload)
  window.addEventListener('online', updateOnlineStatus)
  window.addEventListener('offline', updateOnlineStatus)
  document.addEventListener('visibilitychange', onBadgeVisibilityChange)
  // Re-fetch every store when the connection, the foreground, or the session
  // comes back (LIFT-1226). Without this a failed read stayed stale — and the
  // reconciliation pushes inside each store's fetch stayed parked — until the
  // user fully relaunched the app.
  teardownSyncRecovery = setupSyncRecovery()
  // "Rest Again" on the rest-complete notification (LIFT-1355). The warm path is
  // a service-worker message; the cold path is the launch param read in setup,
  // which is parked here and satisfied once WorkoutTracker mounts.
  teardownRestTimerIntent = restTimerIntent.listen()
  if (launchRestAction === REST_AGAIN_ACTION) restTimerIntent.request()
  // Clear any badge left over from a prior session: visibilitychange does not
  // fire on cold start (the document begins visible), so a badge set before a
  // force-close would otherwise linger on the icon while the user is active.
  clearAppBadge()
  logEvent('session_start')

  // Load Supabase SDK off the critical render path, then start auth.
  // If the SDK fails to load (offline first visit, network error), fall
  // back to local-only mode so the app still renders from localStorage.
  initSupabase()
    .then(() => initAuth())
    .catch(() => initAuth())

  // Request persistent storage to prevent browser eviction
  requestPersistentStorage()

  // Restore from IndexedDB if localStorage was cleared
  const restored = await Promise.all([
    ensureLocalStorage('workout-exercises'),
    ensureLocalStorage('bodyweight-entries'),
    ensureLocalStorage('user-progression'),
    ensureLocalStorage('user-preferences'),
  ])
  if (restored.some(r => r)) {
    // Data was restored from backup — reload stores. Bounded (#1155): if the
    // restore never sticks and this branch re-triggers every boot, the second
    // reload in a session is suppressed and reported instead of looping the
    // app into iOS's "A problem repeatedly occurred" kill screen. On
    // suppression, fall through and finish init on current (empty) state —
    // the restored localStorage still hydrates on the next launch.
    if (guardedReload('idb-restore')) return
  }

  // Welcome-back re-entry moment (LIFT-1107) — evaluated after the restore guard
  // so the banner never flashes ahead of a reload, and after stores hydrate.
  evaluateWelcomeBack()

  // Startup migration and streak catch-up
  if (progressionStore.progressionEnabled && !isMigrated()) {
    const result = computeRetroactiveXP(workoutStore.exercises, bodyweightStore.entries)
    if (result.totalXP > 0) {
      progressionStore.totalXP = result.totalXP
      progressionStore.xpPerSet = result.xpPerSet
      progressionStore.bodyweightXPDates = result.bodyweightXPDates
      const newUnlocks = progressionStore.checkUnlocks()
      progressionStore._persist()
      if (newUnlocks.length > 0) {
        celebrateUnlocks(newUnlocks)
      }
    }
    markMigrated()
  }
  if (!isThemeUnlocked(currentTheme.value as ThemeId)) {
    currentTheme.value = 'pearl'
  }

  if (progressionStore.progressionEnabled) {
    // One-time streak target correction
    const MIGRATION_KEY = 'streak-target-correction-v1'
    if (!localStorage.getItem(MIGRATION_KEY)) {
      localStorage.setItem(MIGRATION_KEY, new Date().toISOString())
      if (progressionStore.pendingTargetChange !== null) {
        progressionStore.weeklyTarget = progressionStore.pendingTargetChange
        progressionStore.pendingTargetChange = null
        const setIdToDate: Record<string, string> = {}
        for (const exercise of workoutStore.exercises) {
          for (const set of exercise.sets) {
            setIdToDate[set.id] = set.date.slice(0, 10)
          }
        }
        progressionStore.reEvaluateStreaks(workoutStore.workoutDates, new Date(), setIdToDate)
      }
    }
    // Evaluate missed weeks
    const setIdToDate: Record<string, string> = {}
    for (const exercise of workoutStore.exercises) {
      for (const set of exercise.sets) {
        setIdToDate[set.id] = set.date.slice(0, 10)
      }
    }
    const streakBefore = progressionStore.streakWeeks
    progressionStore.evaluatePendingWeeks(workoutStore.workoutDates, new Date(), setIdToDate)
    const streakAfter = progressionStore.streakWeeks
    if (progressionStore.showProgression && streakAfter > streakBefore) {
      const MILESTONES = [12, 8, 4, 2] as const
      for (const m of MILESTONES) {
        if (streakAfter >= m && streakBefore < m) {
          const mult = streakAfter >= 12 ? '1.75' : streakAfter >= 8 ? '1.5' : streakAfter >= 4 ? '1.25' : '1.1'
          setTimeout(() => showXPToast(
            `${streakAfter}-week streak! Duration bonus: ${mult}×`,
            progressionStore.progressPercent,
            progressionStore.totalXP,
            progressionStore.nextUnlockThreshold
          ), 1500)
          break
        }
      }
    }
  }

  // Cross-tab sync: reload stores when another tab persists data
  const storeMap: Record<StoreKey, { _reloadFromStorage(): void }> = {
    workout: workoutStore,
    bodyweight: bodyweightStore,
    preferences: usePreferencesStore(),
    progression: progressionStore,
  }
  unsubCrossTab = onCrossTabMessage((msg) => {
    if (msg.type === 'store-update') {
      storeMap[msg.store]?._reloadFromStorage()
    } else if (msg.type === 'sync-status') {
      syncStatus.value = msg.status
    }
  })
})
let unsubCrossTab: (() => void) | null = null
let teardownSyncRecovery: (() => void) | null = null
let teardownRestTimerIntent: (() => void) | null = null
onUnmounted(() => {
  window.removeEventListener('beforeunload', onBeforeUnload)
  window.removeEventListener('online', updateOnlineStatus)
  window.removeEventListener('offline', updateOnlineStatus)
  document.removeEventListener('visibilitychange', onBadgeVisibilityChange)
  clearAppBadge()
  unsubCrossTab?.()
  teardownSyncRecovery?.()
  teardownRestTimerIntent?.()
})
</script>

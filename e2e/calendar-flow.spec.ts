import { test, expect } from '@playwright/test'

// Seed a deterministic workout into localStorage before the app boots so the
// calendar has something to render in detail/week views. Done via addInitScript
// so it lands before the Pinia store reads STORAGE_KEY ('workout-exercises').
function seedWorkout(page: import('@playwright/test').Page) {
  return page.addInitScript(() => {
    localStorage.setItem('onboarding-complete', 'true')
    localStorage.setItem('rest-timer', 'off')
    localStorage.setItem('weight-unit', 'lbs')

    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const todayStr = `${y}-${m}-${d}`

    const exercises = [
      {
        id: 'ex-bench',
        name: 'Bench Press',
        tags: ['Chest'],
        sets: [
          {
            id: 's-bench-1',
            date: `${todayStr}T12:00:00.000Z`,
            weight: 185,
            reps: 5,
            estimated1RM: Math.round(185 * (1 + 5 / 30)),
          },
          {
            id: 's-bench-2',
            date: `${todayStr}T12:05:00.000Z`,
            weight: 195,
            reps: 3,
            estimated1RM: Math.round(195 * (1 + 3 / 30)),
          },
        ],
      },
      {
        id: 'ex-squat',
        name: 'Back Squat',
        tags: ['Legs'],
        sets: [
          {
            id: 's-squat-1',
            date: `${todayStr}T13:00:00.000Z`,
            weight: 225,
            reps: 5,
            estimated1RM: Math.round(225 * (1 + 5 / 30)),
          },
        ],
      },
    ]
    localStorage.setItem('workout-exercises', JSON.stringify(exercises))
  })
}

function todayDateStr(): string {
  const t = new Date()
  const y = t.getFullYear()
  const m = String(t.getMonth() + 1).padStart(2, '0')
  const d = String(t.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

test.describe('Calendar View', () => {
  test.beforeEach(async ({ page }) => {
    await seedWorkout(page)
    await page.goto('/')
    await page.locator('.authDevBtn').click({ timeout: 10000 })
    await expect(page.getByRole('heading', { name: 'Workouts', level: 1 })).toBeVisible({ timeout: 10000 })
    await page.getByRole('tab', { name: 'Calendar' }).click()
    await expect(page.locator('.calCard')).toBeVisible()
  })

  test('renders the Training Calendar header and view toggle', async ({ page }) => {
    await expect(page.locator('.calTitle')).toHaveText('Training Calendar')
    const toggleBtns = page.locator('.calToggleBtn')
    // Year / Month / Week (#620 added the year heatmap); Month stays the default.
    await expect(toggleBtns).toHaveCount(3)
    await expect(toggleBtns.filter({ hasText: 'Year' })).toHaveAttribute('aria-pressed', 'false')
    await expect(toggleBtns.filter({ hasText: 'Month' })).toHaveAttribute('aria-pressed', 'true')
    await expect(toggleBtns.filter({ hasText: 'Week' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('switches between month and week views', async ({ page }) => {
    await expect(page.locator('.calGrid')).toBeVisible()
    await expect(page.locator('.calWeek')).not.toBeVisible()

    await page.locator('.calToggleBtn', { hasText: 'Week' }).click()
    await expect(page.locator('.calWeek')).toBeVisible()
    await expect(page.locator('.calGrid')).not.toBeVisible()
    await expect(page.locator('.calToggleBtn', { hasText: 'Week' })).toHaveAttribute('aria-pressed', 'true')

    await page.locator('.calToggleBtn', { hasText: 'Month' }).click()
    await expect(page.locator('.calGrid')).toBeVisible()
    await expect(page.locator('.calWeek')).not.toBeVisible()
  })

  test('navigates month forward and back, with current-period button disabled today', async ({ page }) => {
    // Today is the current period — the centered "today" pill is disabled.
    await expect(page.locator('.calNavLabel')).toBeDisabled()
    const initialLabel = await page.locator('.calNavLabel').innerText()

    // Forward arrow advances the label and re-enables the centered button.
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.locator('.calNavLabel')).not.toBeDisabled()
    await expect(page.locator('.calNavLabel')).not.toHaveText(initialLabel)

    // Going back returns to the original month and re-disables it.
    await page.getByRole('button', { name: 'Previous' }).click()
    await expect(page.locator('.calNavLabel')).toHaveText(initialLabel)
    await expect(page.locator('.calNavLabel')).toBeDisabled()
  })

  test('returns to today via the centered nav label after navigating away', async ({ page }) => {
    const initialLabel = await page.locator('.calNavLabel').innerText()
    // Move three months forward
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: 'Next' }).click()
    }
    await expect(page.locator('.calNavLabel')).not.toHaveText(initialLabel)
    await expect(page.locator('.calNavLabel')).not.toBeDisabled()

    // Tapping the centered label jumps back to today
    await page.locator('.calNavLabel').click()
    await expect(page.locator('.calNavLabel')).toHaveText(initialLabel)
    await expect(page.locator('.calNavLabel')).toBeDisabled()
  })

  test('highlights today and shows workout dots for seeded day', async ({ page }) => {
    const todayCell = page.locator('.calCell.calCellToday')
    await expect(todayCell).toHaveCount(1)
    await expect(todayCell).toHaveClass(/calCellHasWork/)
    await expect(todayCell.locator('.calDot')).toHaveCount(2)
  })

  test('selecting today opens the day detail with seeded exercises and a "+ Log" button', async ({ page }) => {
    const todayCell = page.locator('.calCell.calCellToday')
    await todayCell.click()
    await expect(todayCell).toHaveClass(/calCellSelected/)

    const detail = page.locator('.calDetail')
    await expect(detail).toBeVisible()
    await expect(detail.locator('.calLogBtn')).toBeVisible()

    // Both seeded exercises listed for the day
    await expect(detail.locator('.calExRowName', { hasText: 'Bench Press' })).toBeVisible()
    await expect(detail.locator('.calExRowName', { hasText: 'Back Squat' })).toBeVisible()

    // Summary bar shows the right counts (2 exercises, 3 sets total)
    const summary = detail.locator('.calSummaryBar')
    await expect(summary).toBeVisible()
    const stats = summary.locator('.calSumValue')
    await expect(stats.nth(0)).toHaveText('2') // exercises
    await expect(stats.nth(1)).toHaveText('3') // sets
  })

  test('expands an exercise row to reveal individual sets', async ({ page }) => {
    await page.locator('.calCell.calCellToday').click()

    const benchRow = page.locator('.calExRow').filter({ has: page.locator('.calExRowName', { hasText: 'Bench Press' }) })
    await expect(benchRow).toHaveAttribute('aria-expanded', 'false')

    await benchRow.click()
    await expect(benchRow).toHaveAttribute('aria-expanded', 'true')

    const setRows = page.locator('.calSetList .calSetRow')
    await expect(setRows).toHaveCount(2)
    // Expect lbs displayed (seed used 185 & 195 lbs)
    await expect(setRows.first()).toContainText('lbs')
    await expect(setRows.first()).toContainText('5 reps')

    // Toggling collapses the list
    await benchRow.click()
    await expect(benchRow).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.calSetList .calSetRow')).toHaveCount(0)
  })

  test('clicking the same day twice deselects it', async ({ page }) => {
    const todayCell = page.locator('.calCell.calCellToday')
    await todayCell.click()
    await expect(todayCell).toHaveClass(/calCellSelected/)
    await expect(page.locator('.calDetail')).toBeVisible()

    await todayCell.click()
    await expect(todayCell).not.toHaveClass(/calCellSelected/)
    await expect(page.locator('.calDetail')).not.toBeVisible()
  })

  test('opens the calendar log modal via the "+ Log" button and supports cancel', async ({ page }) => {
    await page.locator('.calCell.calCellToday').click()
    await page.locator('.calDetail .calLogBtn').click()

    // Exercise picker opens first
    const picker = page.locator('[aria-labelledby="calendar-picker-title"]')
    await expect(picker).toBeVisible()
    await expect(picker.locator('.wtExPickerRow', { hasText: 'Bench Press' })).toBeVisible()

    // Picking an exercise opens the log modal
    await picker.locator('.wtExPickerRow', { hasText: 'Bench Press' }).click()
    const modal = page.locator('[aria-labelledby="cal-modal-title"]')
    await expect(modal).toBeVisible()
    await expect(modal.locator('#cal-modal-title')).toHaveText('Bench Press')

    // Cancel closes without persisting (set count stays at 2)
    await modal.locator('.repMaxBtnClose').click()
    await expect(modal).not.toBeVisible()

    const benchRow = page.locator('.calExRow').filter({ has: page.locator('.calExRowName', { hasText: 'Bench Press' }) })
    await benchRow.click()
    await expect(page.locator('.calSetList .calSetRow')).toHaveCount(2)
  })

  test('logs a new set from the calendar and reflects it in the day summary', async ({ page }) => {
    await page.locator('.calCell.calCellToday').click()
    await page.locator('.calDetail .calLogBtn').click()
    await page.locator('[aria-labelledby="calendar-picker-title"] .wtExPickerRow', { hasText: 'Back Squat' }).click()

    const modal = page.locator('[aria-labelledby="cal-modal-title"]')
    await expect(modal).toBeVisible()

    // Save button disabled until both fields filled
    await expect(modal.locator('.repMaxBtnCalc')).toBeDisabled()

    await modal.locator('input[inputmode="decimal"]').fill('245')
    await modal.locator('input[inputmode="numeric"]').fill('3')

    // Live e1RM estimate appears once both inputs are valid
    await expect(modal.locator('.repMaxResultLabel')).toHaveText('Estimated 1RM')
    await expect(modal.locator('.repMaxBtnCalc')).toBeEnabled()

    await modal.locator('.repMaxBtnCalc').click()
    await expect(modal).not.toBeVisible()

    // Set count now shows 4 (was 3: 2 bench + 1 squat → 2 bench + 2 squat)
    const summaryValues = page.locator('.calSummaryBar .calSumValue')
    await expect(summaryValues.nth(1)).toHaveText('4')

    // Squat row should expose 2 sets after expansion
    const squatRow = page.locator('.calExRow').filter({ has: page.locator('.calExRowName', { hasText: 'Back Squat' }) })
    await squatRow.click()
    await expect(page.locator('.calSetList .calSetRow')).toHaveCount(2)
  })

  test('filters by tag and reflects filtered state on the calendar', async ({ page }) => {
    // Tag filter chips should reflect every seeded tag
    const chips = page.locator('.wtTagFilterBar .wtTagChip').filter({ hasNotText: 'Clear' })
    await expect(chips).toHaveCount(2)

    const todayCell = page.locator('.calCell.calCellToday')
    await expect(todayCell.locator('.calDot')).toHaveCount(2)

    // Filter by Chest only — Back Squat (Legs) drops out, dot count falls to 1
    await page.locator('.wtTagChip', { hasText: 'Chest' }).click()
    await expect(page.locator('.wtTagChip', { hasText: 'Chest' })).toHaveAttribute('aria-pressed', 'true')
    await expect(todayCell.locator('.calDot')).toHaveCount(1)

    // Day detail honors the filter
    await todayCell.click()
    await expect(page.locator('.calDetail .calExRowName', { hasText: 'Bench Press' })).toBeVisible()
    await expect(page.locator('.calDetail .calExRowName', { hasText: 'Back Squat' })).toHaveCount(0)

    // Clear restores all tags
    await page.locator('.wtTagChipClear').click()
    await expect(page.locator('.wtTagChipClear')).toHaveCount(0)
    await expect(todayCell.locator('.calDot')).toHaveCount(2)
  })

  test('week view renders 7 day rows and a "+" log button per day', async ({ page }) => {
    await page.locator('.calToggleBtn', { hasText: 'Week' }).click()

    const rows = page.locator('.calWeekRow')
    await expect(rows).toHaveCount(7)
    await expect(page.locator('.calWeekRowToday')).toHaveCount(1)

    // Today's row should list both seeded exercises
    const todayRow = page.locator('.calWeekRowToday')
    await expect(todayRow.locator('.calExRowName', { hasText: 'Bench Press' })).toBeVisible()
    await expect(todayRow.locator('.calExRowName', { hasText: 'Back Squat' })).toBeVisible()

    // Every day exposes a per-day "+" button (44pt iOS minimum target).
    // We assert presence by aria-label rather than counting the visual "+".
    const logBtns = page.locator('.calWeekDayLogBtn')
    await expect(logBtns).toHaveCount(7)
  })

  test('rest days show "Rest" placeholder in week view', async ({ page }) => {
    await page.locator('.calToggleBtn', { hasText: 'Week' }).click()

    // Only one of the 7 days has seeded data, so we expect 6 Rest placeholders.
    await expect(page.locator('.calWeekRest')).toHaveCount(6)
  })

  test('today date string in seeded data resolves cleanly (smoke)', async ({ page }) => {
    // Sanity check that the date the test seeded matches what the page renders
    // for the selected day. Guards against TZ skew between seed and runtime.
    await page.locator('.calCell.calCellToday').click()
    const detailDate = await page.locator('.calDetailDate').innerText()
    const todayLabel = new Date(todayDateStr() + 'T12:00:00').toLocaleDateString(undefined, {
      weekday: 'long', month: 'long', day: 'numeric',
    })
    // .innerText() returns CSS-transformed text; .calDetailDate uses
    // text-transform: uppercase, so compare case-insensitively to keep
    // this assertion robust to styling changes.
    expect(detailDate.toUpperCase()).toBe(todayLabel.toUpperCase())
  })
})

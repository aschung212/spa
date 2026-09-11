<template>
  <!-- Main card -->
  <div class="wtCard">
    <!-- iOS-style large title + stats subtitle (matches screens/03-workouts.png) -->
    <header class="wtPageHeader">
      <h1 class="wtPageTitle">Workouts</h1>
      <p class="wtPageStats" v-if="store.exercises.length > 0">
        {{ totalExercises }} {{ totalExercises === 1 ? 'exercise' : 'exercises' }}
        · {{ prsThisWeek }} {{ prsThisWeek === 1 ? 'PR' : 'PRs' }} this week
      </p>
      <!-- Weekly training goal indicator (only when progression is enabled) -->
      <div v-if="weeklyGoalInfo" :class="['wtWeeklyGoal', { wtWeeklyGoalMet: weeklyGoalInfo.met, wtWeeklyGoalAtRisk: weeklyGoalInfo.atRisk }]">
        <!-- Flame icon (streak) -->
        <svg class="wtWeeklyGoalIcon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14 0-5.5 3-7 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.5-2.5 1.5-3.5l1 1Z"/></svg>
        <span class="wtWeeklyGoalText">
          <template v-if="weeklyGoalInfo.met">Goal hit — {{ weeklyGoalInfo.trained }}/{{ weeklyGoalInfo.target }} days</template>
          <template v-else-if="weeklyGoalInfo.atRisk">Streak at risk — {{ weeklyGoalInfo.trained }}/{{ weeklyGoalInfo.target }} days</template>
          <template v-else>{{ weeklyGoalInfo.trained }}/{{ weeklyGoalInfo.target }} days this week</template>
        </span>
        <span
          v-if="weekStreak >= 1"
          class="wtStreakBadge"
          :aria-label="`${weekStreak}-week training streak`"
        >{{ weekStreak }}-week streak</span>
      </div>
      <button
        v-if="setsLoggedToday > 0"
        class="wtFinishWorkoutBtn"
        @click="openWorkoutComplete"
        aria-label="Finish workout and view today's summary"
      >
        <span class="wtFinishWorkoutLabel">Finish workout</span>
        <span class="wtFinishWorkoutMeta">
          {{ setsLoggedToday }} {{ setsLoggedToday === 1 ? 'set' : 'sets' }} today
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>
      </button>
    </header>

    <!-- View toggle (Exercises / Timeline) -->
    <div v-if="store.exercises.length > 0" class="wtViewToggle">
      <button :class="['wtViewToggleBtn', { active: listView === 'exercises' }]" @click="listView = 'exercises'">Exercises</button>
      <button :class="['wtViewToggleBtn', { active: listView === 'timeline' }]" @click="listView = 'timeline'">Timeline</button>
    </div>

    <!-- Search bar (exercises view, shown when 5+ exercises) -->
    <div v-if="listView === 'exercises' && store.exercises.length >= 5" class="wtSearchBar">
      <svg class="wtSearchIcon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <input
        v-model="searchQuery"
        type="search"
        autocomplete="off"
        class="wtSearchInput"
        placeholder="Search exercises or tags…"
        aria-label="Search exercises or tags"
      />
      <span v-if="searchQuery" class="wtSearchCount" aria-hidden="true">{{ filteredExercises.length }} result{{ filteredExercises.length !== 1 ? 's' : '' }}</span>
      <span class="srOnly" role="status" aria-live="polite" aria-atomic="true">{{ searchResultAnnouncement }}</span>
    </div>

    <!-- Gym filter chips (#961) — exclusive select, above the additive tag row.
         Always visible in the exercises view: the zero state is "All Gyms" plus
         a labeled "Add Gym" chip, so the first gym can be created right here
         instead of only via Settings (#963 feedback). -->
    <template v-if="listView === 'exercises'">
      <div class="wtTagFilterBar" role="group" aria-label="Filter by gym">
        <button
          :class="['wtTagChip', { wtTagChipActive: !effectiveGymFilter }]"
          @click="activeGymFilter = null"
          aria-label="Show exercises from all gyms"
        >All Gyms</button>
        <button
          v-for="gym in allGyms"
          :key="gym"
          :class="['wtTagChip', { wtTagChipActive: effectiveGymFilter === gym }]"
          :aria-pressed="effectiveGymFilter === gym"
          @click="toggleGymFilter(gym)"
        >
          <span class="wtTagChipLabel">{{ gym }}</span>
        </button>
        <button
          class="wtTagChip wtTagChipManage"
          @click="gymManagerOpen = true"
          :aria-label="allGyms.length > 0 ? 'Manage gyms' : 'Add a gym'"
        ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18"/><path d="M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6"/></svg><template v-if="allGyms.length === 0">Add Gym</template></button>
      </div>
    </template>

    <!-- Tag filter chips with counts (exercises view only) -->
    <template v-if="listView === 'exercises' && store.allTags.length > 0">
      <div class="wtTagFilterBar">
        <button
          :class="['wtTagChip', { wtTagChipActive: activeTagFilters.length === 0 && !searchQuery }]"
          @click="clearSearchAndTags"
          aria-label="Show all exercises"
        >All</button>
        <button
          v-for="tag in filteredTags"
          :key="tag"
          :class="['wtTagChip', { wtTagChipActive: activeTagFilters.includes(tag) }]"
          :aria-pressed="activeTagFilters.includes(tag)"
          @click="toggleTagFilter(tag)"
        >
          <span class="wtTagChipLabel">{{ tag }}</span>
          <span v-if="tagCounts[tag]" class="wtTagChipCount">{{ tagCounts[tag] }}</span>
        </button>
        <button
          class="wtTagChip wtTagChipManage"
          @click="openTagManager"
          aria-label="Manage tags"
        ><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg></button>
      </div>
    </template>

    <div v-if="store.exercises.length === 0 && showFreshStart" class="wtFreshStart">
      <div class="wtFreshStartIcon" aria-hidden="true">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
      </div>
      <p class="wtFreshStartTitle">You're starting fresh!</p>
      <p class="wtFreshStartBody">Add your first exercise to begin tracking your lifts.</p>
      <button class="wtFreshStartCta" @click="openNewExerciseModal">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Exercise
      </button>
    </div>
    <p v-else-if="store.exercises.length === 0" class="wtEmpty">
      No exercises yet. Tap the "+" in the top right to add your first one.
    </p>

    <template v-else-if="listView === 'exercises'">
    <p v-if="filteredExercises.length === 0 && !isFilteringActive && store.archivedExercises.length > 0" class="wtEmpty">
      All your exercises are archived. Expand "Archived" below to bring one back, or tap "+ New Exercise".
    </p>
    <p v-else-if="filteredExercises.length === 0" class="wtEmpty">
      {{ effectiveGymFilter ? 'No exercises match your filters.' : 'No exercises match your search.' }}
    </p>

    <!-- Guided session plan (#1256): the last session in the current scope
         (gym + tags) as a day-level checklist. History is the template — no
         authoring surface. Rows open the existing log modal, where the
         routine lens / ghost-arm flow takes over. Hidden while searching. -->
    <section v-if="sessionPlan && !searchQuery" class="wtSessionPlan" aria-label="Session plan">
      <button
        class="wtSessionPlanToggle"
        :aria-expanded="sessionPlanExpanded"
        :aria-controls="sessionPlanListId"
        @click="toggleSessionPlan"
      >
        <svg class="wtSessionPlanIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 2l4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>
        <span class="wtSessionPlanTitleBlock">
          <span class="wtSessionPlanTitle">{{ sessionPlanLabel }}</span>
          <span class="wtSessionPlanMeta">
            <template v-if="sessionPlan.doneTotal > 0">{{ sessionPlan.doneTotal }}/{{ sessionPlan.plannedTotal }} sets · {{ sessionPlanDayLabel }}</template>
            <template v-else>{{ sessionPlan.items.length }} {{ sessionPlan.items.length === 1 ? 'exercise' : 'exercises' }} · {{ sessionPlan.plannedTotal }} {{ sessionPlan.plannedTotal === 1 ? 'set' : 'sets' }} · {{ sessionPlanDayLabel }}</template>
          </span>
        </span>
        <span class="wtSessionPlanChevron" :class="{ expanded: sessionPlanExpanded }" aria-hidden="true">›</span>
      </button>
      <ul v-if="sessionPlanExpanded" :id="sessionPlanListId" class="wtSessionPlanList">
        <li v-for="item in sessionPlan.items" :key="item.exerciseId" class="wtSessionPlanItem">
          <button
            :class="['wtSessionPlanRow', { wtSessionPlanRowDone: item.doneSets >= item.plannedSets }]"
            @click="logFromSessionPlan(item.exerciseId)"
            :aria-label="`${item.name}, ${Math.min(item.doneSets, item.plannedSets)} of ${item.plannedSets} sets done. Log a set.`"
          >
            <span class="wtSessionPlanNameBlock">
              <span class="wtSessionPlanName">{{ item.name }}</span>
              <span class="wtSessionPlanRowMeta">
                {{ item.plannedSets }} {{ item.plannedSets === 1 ? 'set' : 'sets' }}<template v-if="item.topSet"> · top {{ displayWeight(item.topSet.weightLbs) }} {{ weightUnit }} × {{ item.topSet.reps }}</template>
              </span>
            </span>
            <span v-if="item.doneSets >= item.plannedSets" class="wtSessionPlanCheck" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
            </span>
            <span v-else class="wtSessionPlanProgress" aria-hidden="true">{{ item.doneSets }}/{{ item.plannedSets }}</span>
          </button>
        </li>
      </ul>
    </section>

    <!-- Explore-path one-time tip: point new users at the payoff charts
         they'd otherwise miss (the sample journey is only demonstrative if
         they open an exercise). Shown only while sample data is present. (LIFT-1086) -->
    <div v-if="showChartTip" class="wtChartTip" role="note">
      <svg class="wtChartTipIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/></svg>
      <span class="wtChartTipText">Tap any exercise to see its progress chart</span>
      <button class="wtChartTipDismiss" @click="dismissChartTip" aria-label="Dismiss tip">×</button>
    </div>

    <ul v-if="filteredExercises.length > 0" class="wtExerciseList">
      <li
        v-for="exercise in filteredExercises"
        :key="exercise.id"
        v-memo="[exercise.name, exercise.sets.length, exercise.sets[exercise.sets.length - 1]?.weight, exercise.sets[exercise.sets.length - 1]?.reps, exercise.tags, prBaselineDate, weightUnit]"
        class="wtExerciseItem"
      >
        <div class="wtExerciseHeader">
          <button
            class="wtExerciseRow"
            @click="openDetailModal(exercise.id)"
          >
            <div class="wtExerciseNameBlock">
              <div class="wtExerciseTopLine">
                <span class="wtExerciseName">{{ exercise.name }}</span>
                <span v-if="rowMetaByExercise[exercise.id]?.isNewPRBadge" class="wtExerciseNewPR">
                  <span class="wtExerciseNewPRIcon" aria-hidden="true">🏆</span>
                  <span>NEW PR</span>
                </span>
              </div>
              <div class="wtExerciseMetaLine">
                <span
                  v-for="tag in (exercise.tags || []).slice(0, 3)"
                  :key="tag"
                  class="wtExerciseTag"
                >{{ tag }}</span>
                <span v-if="rowMetaByExercise[exercise.id]?.lastSet" class="wtExerciseStat">
                  · {{ rowMetaByExercise[exercise.id]!.lastSet!.load }}
                  × {{ rowMetaByExercise[exercise.id]!.lastSet!.reps }}
                  · {{ rowMetaByExercise[exercise.id]!.timeAgo }}
                </span>
                <span v-else class="wtExerciseStat wtExerciseStatEmpty">· No sets yet</span>
              </div>
            </div>
          </button>
          <button
            class="wtExerciseLogBtn wtExerciseLogBtnCircle"
            @click="openLogForExercise(exercise.id)"
            :aria-label="`Log a set for ${exercise.name}`"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="20" height="20" aria-hidden="true">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>
        </div>
      </li>
    </ul>

    <!-- Archived exercises disclosure -->
    <div v-if="store.archivedExercises.length > 0 && !isFilteringActive" class="wtArchivedSection">
      <button
        class="wtArchivedToggle"
        :aria-expanded="archivedOpen"
        :aria-controls="archivedListId"
        @click="archivedOpen = !archivedOpen"
      >
        <span class="wtArchivedToggleIcon" :class="{ expanded: archivedOpen }" aria-hidden="true">›</span>
        <span class="wtArchivedToggleLabel">Archived</span>
        <span class="wtArchivedToggleCount">{{ store.archivedExercises.length }}</span>
      </button>
      <ul v-if="archivedOpen" :id="archivedListId" class="wtArchivedList">
        <li
          v-for="ex in store.archivedExercises"
          :key="ex.id"
          class="wtArchivedItem"
        >
          <button
            class="wtArchivedRow"
            @click="openDetailModal(ex.id)"
            :aria-label="`View ${ex.name} (archived)`"
          >
            <span class="wtArchivedName">{{ ex.name }}</span>
            <span class="wtArchivedMeta">{{ ex.sets.length }} {{ ex.sets.length === 1 ? 'set' : 'sets' }}</span>
          </button>
          <button
            class="wtArchivedActionBtn"
            @click="unarchiveExerciseFromList(ex.id)"
            :aria-label="`Unarchive ${ex.name}`"
          >Unarchive</button>
        </li>
      </ul>
    </div>
    </template>

    <!-- Timeline view (extracted to WorkoutTimeline.vue) -->
    <WorkoutTimeline
      v-else-if="listView === 'timeline'"
      :exercises="liveExercises"
      :pr-baseline-date="prBaselineDate"
      :warmup-threshold="_prefs.filters.warmupThreshold"
      @log-set="openTimelineLogModal"
      @edit-set="onTimelineEditSet"
      @delete-set="undoDeleteSet"
    />

  </div>

  <!-- Exercise detail modal -->
  <ExerciseDetailModal
    :exercise-id="detailExerciseId"
    @close="detailExerciseId = null"
    @open-log-set="openLogForExercise"
    @open-edit-exercise="openEditExerciseModal"
    @edit-set="openEditModal"
    @delete-set="undoDeleteSet"
  />


  <!-- Log / Edit Set Modal -->
  <Teleport to="body">
    <div v-if="showModal" class="repMaxOverlay logSetOverlay" @click.self="onOverlayClick" @keydown.escape="closeModal">
      <div ref="logSheetEl" class="repMaxModal logSetSheet" :class="{ logSetSheetForm: !timerCtrl.timerActive.value }" :style="logSwipe.dragStyle()" @click.self="timerCtrl.editingPresets.value = false" role="dialog" aria-modal="true" aria-labelledby="log-modal-title">
        <div ref="logSheetHandleEl" class="logSetSheetHandle" aria-hidden="true"></div>

        <!-- Rest timer view -->
        <template v-if="timerCtrl.timerActive.value">
          <RestTimerContent
            :exercise-name="selectedExerciseName"
            :ctrl="timerCtrl"
            @skip-to-next="skipToNextSet"
            @dismiss="dismissTimer"
            @close="closeModal"
            @restore="showModal = true"
          />
        </template>

        <!-- Log / edit form -->
        <template v-else>
          <div class="wtModalHeader">
            <button v-if="isLogForExercise" class="wtLogHistoryBtn" @click="openHistoryFromLog" aria-label="View set history">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>
            </button>
            <h2 id="log-modal-title">{{ modalTitle }}</h2>
            <button v-if="isLogForExercise" class="wtPlateSettingsBtn" @click="openEditExerciseModal(store.exercises.find(e => e.id === selectedExerciseId)!)" aria-label="Exercise settings">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>

          <!-- Screen-reader confirmation of the last saved/edited set (#1148).
               The modal stays open with cleared fields after a save, so this
               polite live region is the only save feedback a blind user gets. -->
          <span class="srOnly" role="status" aria-live="polite" aria-atomic="true">{{ setLogAnnouncement }}</span>

          <!-- New exercise mode: name + tags input -->
          <template v-if="!isEditMode && selectedExerciseId === '__new__'">
            <!--
              Exercise-name autocomplete as an ARIA combobox + listbox (LIFT-1304).
              The listbox is a SIBLING of the <label>, not a child: an implicit
              label contributes its ENTIRE subtree to the accessible name, so a
              nested list made the field announce as "Exercise name Bench Press
              Chest · Push Incline Bench Press …". The wrapper carries the
              label's bottom margin so the layout is unchanged.
            -->
            <div class="wtNewExerciseNameField">
              <label class="repMaxLabel">
                Exercise name
                <div class="repMaxInputRow">
                  <input
                    v-model.trim="newExerciseName"
                    type="text"
                    placeholder="e.g. Bench Press"
                    class="repMaxInput"
                    maxlength="50"
                    autocomplete="off"
                    role="combobox"
                    aria-autocomplete="list"
                    :aria-expanded="suggestionsOpen"
                    :aria-controls="suggestionsOpen ? EXERCISE_SUGGESTIONS_ID : undefined"
                    :aria-activedescendant="activeSuggestionId"
                    @keydown="onExerciseNameKeydown"
                  />
                </div>
              </label>
              <ul v-if="suggestionsOpen" :id="EXERCISE_SUGGESTIONS_ID" class="wtExerciseSuggestions" role="listbox" aria-label="Exercise suggestions">
                <li
                  v-for="(entry, i) in exerciseSuggestions"
                  :id="suggestionOptionId(i)"
                  :key="entry.name"
                  :class="['wtExerciseSuggestionItem', { wtExerciseSuggestionItemActive: i === activeSuggestionIndex }]"
                  role="option"
                  :aria-selected="i === activeSuggestionIndex"
                  tabindex="-1"
                  @mousedown.prevent="selectExerciseSuggestion(entry)"
                  @touchstart.prevent="selectExerciseSuggestion(entry)"
                >
                  <span class="wtSuggestionName">{{ entry.name }}</span>
                  <span class="wtSuggestionTags">{{ entry.tags.join(' · ') }}</span>
                </li>
              </ul>
            </div>
            <div class="repMaxLabel">
              Tags
              <div class="wtTagPicker">
                <button
                  v-for="tag in allNewExerciseTags"
                  :key="tag"
                  :class="['wtTagPickerChip', { wtTagPickerChipActive: newExerciseTags.includes(tag) }]"
                  :style="!newExerciseTags.includes(tag)
                    ? { borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }
                    : {}"
                  @click="toggleNewExerciseTag(tag)"
                >{{ tag }}</button>
                <span v-if="newTagAdding" class="wtTagInlineAdd">
                  <input
                    v-model.trim="newExerciseTagInput"
                    type="text"
                    autocomplete="off"
                    placeholder="Tag name"
                    maxlength="30"
                    class="wtTagInlineInput"
                    ref="newTagInputEl"
                    aria-label="New tag name"
                    @keyup.enter="addNewExerciseTag"
                    @blur="finishNewTagAdd"
                  />
                </span>
                <button v-else class="wtTagPickerChip wtTagAddChip" @mousedown.prevent @click="startNewTagAdd" aria-label="Add tag">+</button>
              </div>
            </div>
            <!--
              Gym membership at creation time (#984). Mirrors EditExerciseModal's
              Gym section so there is one interaction path, not two — but here it
              seeds `gyms` through addExercise itself rather than round-tripping
              through setExerciseGyms. Always rendered: with no gyms configured
              the inline "+" is a first-gym creation path, same as #963.
            -->
            <div class="repMaxLabel">
              Gym
              <div class="wtTagPicker" role="group" aria-label="Gym membership">
                <button
                  v-for="gym in allGyms"
                  :key="gym"
                  :aria-pressed="newExerciseGyms.includes(gym)"
                  :class="['wtTagPickerChip', { wtTagPickerChipActive: newExerciseGyms.includes(gym) }]"
                  :style="!newExerciseGyms.includes(gym)
                    ? { borderColor: 'var(--border-strong)', color: 'var(--text-secondary)' }
                    : {}"
                  @click="toggleNewExerciseGym(gym)"
                >{{ gym }}</button>
                <span v-if="newGymAdding" class="wtTagInlineAdd">
                  <input
                    v-model.trim="newExerciseGymInput"
                    type="text"
                    autocomplete="off"
                    placeholder="Gym name"
                    :maxlength="GYM_NAME_MAX_LENGTH"
                    class="wtTagInlineInput"
                    ref="newGymInputEl"
                    aria-label="New gym name"
                    @keyup.enter="addNewExerciseGym"
                    @blur="finishNewGymAdd"
                  />
                </span>
                <button v-else-if="allGyms.length < MAX_GYMS" class="wtTagPickerChip wtTagAddChip" @mousedown.prevent @click="startNewGymAdd" aria-label="Add gym">+</button>
              </div>
              <span class="iosSettingsFooter">Leave empty to show this exercise at every gym.</span>
            </div>
            <!-- Plate calculator settings for new exercise -->
            <div class="iosSettingsSection">
              <span class="iosSettingsHeader">Input Mode</span>
              <div class="iosSettingsGroup">
                <!-- Named by the visible row label, not a duplicated
                     `aria-label` string — see EditExerciseModal (LIFT-1308). -->
                <div class="iosSettingsRow">
                  <span id="wt-new-exercise-plate-mode-label" class="iosSettingsRowLabel">Plate calculator</span>
                  <button
                    class="iosToggle"
                    :class="{ iosToggleOn: newExercisePlateMode }"
                    role="switch"
                    :aria-checked="newExercisePlateMode"
                    aria-labelledby="wt-new-exercise-plate-mode-label"
                    @click="newExercisePlateMode = !newExercisePlateMode"
                  >
                    <span class="iosToggleKnob"></span>
                  </button>
                </div>
                <template v-if="newExercisePlateMode">
                  <div class="iosSettingsRow">
                    <span class="iosSettingsRowLabel">Counting</span>
                    <div class="iosSegmentedControl">
                      <button
                        :class="['iosSegment', { iosSegmentActive: newExercisePlateCountMode === 'per-side' }]"
                        @click="newExercisePlateCountMode = 'per-side'"
                      >Per side</button>
                      <button
                        :class="['iosSegment', { iosSegmentActive: newExercisePlateCountMode === 'total' }]"
                        @click="newExercisePlateCountMode = 'total'"
                      >Total</button>
                    </div>
                  </div>
                  <div class="iosSettingsRow">
                    <span class="iosSettingsRowLabel">Starting weight</span>
                    <div class="iosStepper">
                      <button class="iosStepperBtn" @click="newExerciseBarWeight = Math.max(0, newExerciseBarWeight - 5)" aria-label="Decrease weight">−</button>
                      <input
                        v-if="newBarWeightEditing"
                        ref="newBarWeightInputEl"
                        :value="newExerciseBarWeight"
                        type="text"
                        inputmode="numeric"
                        autocomplete="off"
                        class="iosStepperInput"
                        aria-label="Starting weight"
                        @focus="($event.target as HTMLInputElement)?.select(); scrollInputAboveKeyboard($event.target as HTMLElement)"
                        @blur="newExerciseBarWeight = Math.max(0, Math.min(MAX_WEIGHT, Math.round(Number(($event.target as HTMLInputElement).value) || 0))); newBarWeightEditing = false"
                      />
                      <button v-else class="iosStepperValue iosStepperValueTappable" @click="newBarWeightEditing = true; nextTick(() => newBarWeightInputEl?.focus())">{{ newExerciseBarWeight }} {{ weightUnit }}</button>
                      <button class="iosStepperBtn" @click="newExerciseBarWeight = Math.min(MAX_WEIGHT, newExerciseBarWeight + 5)" aria-label="Increase weight">+</button>
                    </div>
                  </div>
                </template>
              </div>
            </div>
          </template>

          <!-- Date as subtitle (tappable) -->
          <p v-else-if="isLogForExercise || isEditMode" class="wtModalSubtitle">
            <span class="wtDateBtnWrap">
              <span class="wtDateMetaLabel" aria-hidden="true">{{ dateDisplay }}</span>
              <input
                v-model="date"
                type="date"
                autocomplete="off"
                :max="todayISO()"
                ref="dateInputEl"
                tabindex="-1"
                class="wtDateOverlayInput"
                :aria-label="'Log date, currently ' + dateDisplay"
                @click="tryShowDatePicker"
              />
            </span>
          </p>

          <!--
            Consolidated "Suggestions" drawer (#759 / #770) — one interaction
            path, not three. Folds the usual-ladder / last-session quick-fill and
            the PR-anchored Intensity table into a single segmented disclosure.
            The routine ladder (or last-session) lens is the default and stays
            expanded so the one-tap ghost-arm logging flow is preserved; the
            Intensity slider is a tap away on the segmented control. The Intensity
            lens ceils to a loadable plate increment, so its 100% end reaches
            PR-beating loads — the former separate PR table is just this table
            read at 100% (#770). Each lens reuses its existing chip/row markup.
          -->
          <div
            v-if="!isEditMode && isLogForExercise && suggestionLenses.length"
            :class="['wtPrTargets', 'wtSuggestions', { wtPrTargetsExpanded: suggestionsExpanded }]"
          >
            <button class="wtPrTargetsHeader" @click="suggestionsExpanded = !suggestionsExpanded" :aria-expanded="suggestionsExpanded">
              <span class="wtPrTargetsTitleCol">
                <span class="wtPrTargetsTitle">Suggestions</span>
                <span class="wtPrTargetsSub">{{ suggestionHeaderSub }}</span>
              </span>
              <svg :class="['wtPrTargetsChevron', { wtPrTargetsChevronOpen: suggestionsExpanded }]" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>

            <div v-if="suggestionsExpanded" class="wtSuggestionBody">
              <div v-if="suggestionLenses.length > 1" class="wtSuggestionSegments" role="tablist" aria-label="Suggestion type">
                <button
                  v-for="lens in suggestionLenses"
                  :key="lens"
                  type="button"
                  role="tab"
                  :aria-selected="currentLens === lens"
                  :class="['wtSuggestionSegment', { wtSuggestionSegmentActive: currentLens === lens }]"
                  @click="activeLens = lens"
                >{{ lensLabel(lens) }}</button>
              </div>

              <!-- Routine: usual-ladder rungs (quick-fill + ghost-arm) -->
              <template v-if="currentLens === 'routine' && usualLadder">
                <span class="wtPrevSessionLabel">{{ ladderLabel }}</span>
                <div ref="ladderChipsEl" class="wtPrevSessionChips">
                  <button
                    v-for="(rung, i) in usualLadder.rungs"
                    :key="i"
                    class="wtPrevSessionChip"
                    :class="{
                      wtPrevSessionChipUsed: rungStates[i] === 'done',
                      wtPrevSessionChipNext: rungStates[i] === 'next',
                      wtPrevSessionChipSkipped: rungStates[i] === 'skipped',
                    }"
                    :aria-current="rungStates[i] === 'next' ? 'step' : undefined"
                    :aria-label="rungStates[i] === 'done' ? `${displayWeight(rung.weightLbs)} × ${rung.reps}, logged`
                      : rungStates[i] === 'skipped' ? `${displayWeight(rung.weightLbs)} × ${rung.reps}, skipped` : undefined"
                    @click="fillFromRung(rung)"
                  >{{ displayWeight(rung.weightLbs) }} × {{ rung.reps }}</button>
                </div>
              </template>

              <!-- Last session quick-fill (fallback when no routine is detected) -->
              <template v-else-if="currentLens === 'last' && lastSession">
                <span class="wtPrevSessionLabel">Last session · {{ formatShortDate(lastSession.date + 'T12:00:00') }}</span>
                <div class="wtPrevSessionChips">
                  <button
                    v-for="(s, i) in lastSession.sets"
                    :key="i"
                    class="wtPrevSessionChip"
                    :class="{ wtPrevSessionChipUsed: lastSessionUsed[i] }"
                    @click="fillFromLastSession(s, i)"
                  >{{ displayWeight(s.weight) }} × {{ s.reps }}</button>
                </div>
              </template>

              <!-- Intensity: PR-anchored weight × reps at the chosen % of max.
                   Ceiling rounding means the 100% end reaches PR-beating loads,
                   so this one lens spans warmups → PR (#770). -->
              <template v-else-if="currentLens === 'intensity'">
                <span class="wtPrevSessionLabel">{{ intensityPct }}% of {{ displayWeight(intensityOneRM!) }} {{ weightUnit }} {{ baselineMaxLabel }}</span>
                <!-- Tappable presets (configured in Settings, #776) — the fast path;
                     the slider below stays for one-off intensities. -->
                <div v-if="intensityPresets.length" class="wtPrevSessionChips wtIntensityPresetChips" role="group" aria-label="Intensity presets">
                  <button
                    v-for="p in intensityPresets"
                    :key="p"
                    type="button"
                    class="wtPrevSessionChip"
                    :class="{ wtPrevSessionChipNext: intensityPct === p }"
                    :aria-pressed="intensityPct === p"
                    @click="intensityPct = p"
                  >{{ p }}%</button>
                </div>
                <div class="wtIntensityControl">
                  <input
                    type="range"
                    min="0"
                    max="100"
                    :step="INTENSITY_STEP"
                    v-model.number="intensityPct"
                    class="wtIntensitySlider"
                    :aria-label="`Intensity, ${intensityPct} percent of max`"
                  />
                  <span class="wtIntensityValue">{{ intensityPct }}%</span>
                </div>
                <div v-if="intensityTable.length" class="wtPrTargetsList wtSuggestionList">
                  <button
                    v-for="(row, i) in intensityTable"
                    :key="row.reps"
                    :class="['wtPrTargetsRow', { wtPrTargetsRowActive: intensityUsed[i] }]"
                    :aria-label="`${row.weight} ${weightUnit} for ${row.reps} reps, ${row.e1rm} ${weightUnit} estimated 1RM`"
                    @click="fillFromIntensity(row, i)"
                  >
                    <span class="wtPrTargetsReps">{{ row.reps }}</span>
                    <span class="wtPrTargetsRepsLabel">{{ row.reps === 1 ? 'rep' : 'reps' }}</span>
                    <!-- Rows are already in the display unit (LIFT-1315) — running
                         them through displayWeight() again would convert twice. -->
                    <span class="wtPrTargetsWeight">{{ row.weight }} {{ weightUnit }}</span>
                    <span class="wtPrTargetsE1rm">~{{ row.e1rm }} {{ weightUnit }} e1RM</span>
                  </button>
                </div>
                <p v-else class="wtIntensityEmpty">Nothing loadable at {{ intensityPct }}% — slide higher.</p>
              </template>
            </div>
          </div>

          <!-- Weight + Reps (primary inputs — keep at top for keyboard visibility) -->
          <div v-if="selectedExerciseId === '__new__'" class="wtSectionDivider">
            <span class="wtSectionDividerLine"></span>
            <span class="wtSectionDividerText">Log a set (optional)</span>
            <span class="wtSectionDividerLine"></span>
          </div>
          <!-- Live 1RM estimate / PR target -->
          <div v-if="liveEstimate" class="repMaxResult">
            <span class="repMaxResultLabel">Estimated 1RM{{ liveXPPreview?.best1RM ? ` (${baselineBestLabel}: ${liveXPPreview.best1RM} ${weightUnit})` : '' }}</span>
            <span class="repMaxResultValue">{{ liveEstimate }} {{ weightUnit }}</span>
            <span v-if="isNewPR" class="wtPrBadge">{{ prBadgeLabel }}</span>
            <span v-if="liveXPPreview" class="wtXPPreview">{{ liveXPPreview.zone }}{{ liveXPPreview.isRepPR ? ` · Rep PR (${XP_CONFIG.repPRMultiplier}x)` : liveXPPreview.isNewWeight ? ' · New weight' : '' }} · {{ liveXPPreview.xp }} XP</span>
          </div>
          <!-- The to-beat cards are controls, so they carry the app's settled
               custom-button shape — role + tabindex + BOTH activation keys
               (LIFT-1305). Accessible name comes from the contents, which the
               button role permits, so it can never drift from what is on screen.
               This card is only a control in plate mode, so role/tabindex are
               bound to the same flag that makes it look tappable. -->
          <div
            v-else-if="prTargetWeight"
            class="repMaxResult repMaxResultTarget"
            :class="{ repMaxResultTappable: plateMode }"
            :role="plateMode ? 'button' : undefined"
            :tabindex="plateMode ? 0 : undefined"
            @click="plateMode && loadPRTarget()"
            @keydown.enter="plateMode && loadPRTarget()"
            @keydown.space.prevent="plateMode && loadPRTarget()"
          >
            <span class="repMaxResultLabel">{{ prTargetLabel }}</span>
            <span class="repMaxResultValue">{{ prTargetWeight }} {{ weightUnit }} × {{ reps }}</span>
            <span v-if="bestWeightAtReps" class="repMaxPersonalBest">Your best at {{ reps }} rep{{ reps === 1 ? '' : 's' }}: {{ displayWeight(bestWeightAtReps) }} {{ weightUnit }}</span>
            <span v-if="plateMode" class="repMaxPersonalBest">Tap to load plates</span>
          </div>
          <!-- Bodyweight-loaded and the lifter's own bodyweight at this rep count
               already beats their best — no added weight to suggest (#1328).
               Tappable like every other to-beat card since LIFT-1330: "add
               nothing" is now a value the field can hold, so the card loads its
               own answer (0) instead of leaving the one target in the sheet that
               the lifter has to translate by hand. -->
          <div
            v-else-if="bodyweightBeatsPRTarget"
            class="repMaxResult repMaxResultTarget repMaxResultTappable"
            role="button"
            tabindex="0"
            @click="loadBodyweightOnlyTarget"
            @keydown.enter="loadBodyweightOnlyTarget"
            @keydown.space.prevent="loadBodyweightOnlyTarget"
          >
            <span class="repMaxResultLabel">{{ prTargetLabel }}</span>
            <span class="repMaxResultValue">Bodyweight × {{ reps }} 🏆</span>
            <span class="repMaxPersonalBest">Bodyweight alone at {{ reps }} rep{{ reps === 1 ? '' : 's' }} beats {{ isRecentBaseline ? 'your recent best' : 'your best' }} — no added weight needed</span>
            <span class="repMaxPersonalBest">Tap to set added weight</span>
          </div>
          <div
            v-else-if="prTargetReps === 0"
            class="repMaxResult repMaxResultTarget repMaxResultTappable"
            role="button"
            tabindex="0"
            @click="loadSinglePRTargetRep"
            @keydown.enter="loadSinglePRTargetRep"
            @keydown.space.prevent="loadSinglePRTargetRep"
          >
            <span class="repMaxResultLabel">{{ prTargetLabel }}</span>
            <span class="repMaxResultValue">{{ displayWeight(toLbs(weight!)) }} {{ weightUnit }} × 1 🏆</span>
            <span class="repMaxPersonalBest">Any rep at this weight is a {{ isRecentBaseline ? 'new recent best' : 'new PR' }}</span>
            <span class="repMaxPersonalBest">Tap to set reps</span>
          </div>
          <div
            v-else-if="prTargetReps"
            class="repMaxResult repMaxResultTarget repMaxResultTappable"
            role="button"
            tabindex="0"
            @click="loadPRTargetReps"
            @keydown.enter="loadPRTargetReps"
            @keydown.space.prevent="loadPRTargetReps"
          >
            <span class="repMaxResultLabel">{{ prTargetLabel }}</span>
            <span class="repMaxResultValue">{{ displayWeight(toLbs(weight!)) }} {{ weightUnit }} × {{ prTargetReps }}</span>
            <span v-if="bestRepsAtWeight" class="repMaxPersonalBest">Your best at {{ displayWeight(toLbs(weight!)) }} {{ weightUnit }}: {{ bestRepsAtWeight }} rep{{ bestRepsAtWeight === 1 ? '' : 's' }}</span>
            <span v-else class="repMaxPersonalBest">New weight — first attempt at {{ displayWeight(toLbs(weight!)) }} {{ weightUnit }}</span>
            <span class="repMaxPersonalBest">Tap to set reps</span>
          </div>
          <div
            v-else-if="overloadNudge"
            class="repMaxResult repMaxResultTarget repMaxResultTappable wtOverloadCard"
            role="button"
            tabindex="0"
            :aria-label="`Load suggested set, ${overloadNudge.displayWeight} ${weightUnit} × ${overloadNudge.reps}`"
            @click="acceptOverloadNudge"
            @keydown.enter="acceptOverloadNudge"
            @keydown.space.prevent="acceptOverloadNudge"
          >
            <span class="repMaxResultLabel">Suggestion</span>
            <span class="repMaxResultValue">{{ overloadNudge.displayWeight }} {{ weightUnit }} × {{ overloadNudge.reps }}</span>
            <span class="repMaxPersonalBest">Up from {{ displayWeight(overloadNudge.fromWeightLbs) }} {{ weightUnit }} × {{ overloadNudge.fromReps }} · Tap to load</span>
          </div>
          <div v-else-if="!isEditMode && isLogForExercise" class="repMaxResult repMaxResultPlaceholder">
            <span class="repMaxResultLabel">Estimated 1RM</span>
            <span class="repMaxResultPlaceholderText">Enter weight and reps to see estimate</span>
          </div>

          <!--
            Primary WEIGHT + REPS cards per screens/05-logset-platecalc.png.
            Layout: two cards side-by-side, weight (~60%) on the left with a
            big 44px number and the unit suffix, reps (~40%) on the right
            with the value stacked above a [−][+] stepper.

            Shown in BOTH numpad and plate modes — in plate mode the WEIGHT
            input displays the live-computed total from the plates picker
            below, and typing into it switches to manual override (the
            existing `syncPlatesFromWeight` watcher reverse-syncs plates).
            The standalone reps stepper that used to render in plate mode
            is gone — the REPS card here covers the same job and avoids
            the parallel input that gemini-3.1-pro flagged as a P1
            (the v-else previously hid this row entirely in plate mode,
            which after step 5c removed the in-card weight display would
            leave the user with no visible weight at all).
          -->
          <div class="wtInputRow logSetFieldsRow">
            <!-- On a bodyweight-loaded exercise the field means ADDED weight, so
                 it says so (LIFT-1330) — "Weight: 135" on a pull-up reads as if
                 the lifter has to load something, which is how a plain
                 bodyweight set came to look unloggable. The accessible name
                 tracks the visible label rather than staying pinned to "Weight"
                 (WCAG 2.5.3), and the placeholder drops the barbell-sized 135. -->
            <label :class="['repMaxLabel', 'logSetField', 'logSetFieldWeight', { logSetFieldActive: weightHasValue }]">
              <span class="logSetFieldLabel">{{ weightFieldLabel }} <span class="logSetFieldLabelUnit">({{ weightUnit }})</span></span>
              <div class="logSetFieldValueRow">
                <input
                  ref="weightInputEl"
                  v-model="weightStr"
                  type="text"
                  inputmode="decimal"
                  enterkeyhint="next"
                  autocomplete="off"
                  :placeholder="weightFieldPlaceholder"
                  class="repMaxInput logSetFieldInput"
                  :aria-label="weightFieldAriaLabel"
                />
                <button
                  v-if="weightHasValue"
                  type="button"
                  class="logSetFieldClear"
                  aria-label="Clear weight"
                  @click.prevent="clearWeight"
                >×</button>
              </div>
            </label>

            <div :class="['repMaxLabel', 'logSetField', 'logSetFieldReps', { logSetFieldActive: reps !== null && reps > 0 }]">
              <span class="logSetFieldLabel">Reps</span>
              <input
                v-model="repsStr"
                type="text"
                inputmode="numeric"
                enterkeyhint="done"
                autocomplete="off"
                :placeholder="ghostArmed && nextRung ? String(nextRung.reps) : '—'"
                class="repMaxInput logSetFieldInput logSetFieldInputReps"
                aria-label="Reps"
              />
              <div class="logSetFieldStepRow">
                <button
                  type="button"
                  class="logSetStepBtn"
                  :disabled="reps === null || reps <= 0"
                  aria-label="Decrease reps"
                  @click="adjustReps(-1)"
                >−</button>
                <button
                  type="button"
                  class="logSetStepBtn logSetStepBtnPrimary"
                  :disabled="reps !== null && reps >= MAX_REPS"
                  aria-label="Increase reps"
                  @click="adjustReps(1)"
                >+</button>
              </div>
            </div>
          </div>

          <!--
            Set annotations (#1271 / LIFT-617). "Went for one more" and the
            RPE rating are both optional, per-set annotations, so they share
            ONE 44pt row rather than stacking two. Stacking cost 112px of
            sheet height UNCONDITIONALLY — both rows already sat at the 44pt
            floor, so the sheet paid the same whether or not either annotation
            was used, and each pill occupies well under half the row.

            The effort toggle records that the lifter attempted the rep AFTER
            the logged count and missed it, which is a strictly higher-output
            set than the same reps re-racked. One optional tap, off by default
            — this fires on every set, so a blocking prompt would cost more
            than the ambiguity it removes. aria-pressed rather than a
            checkbox: it is a two-state toggle button, and the label already
            carries the target rep.
          -->
          <div class="wtEffortRow">
            <button
              type="button"
              :class="['wtEffortToggle', { wtEffortToggleActive: attemptedNextRep }]"
              :aria-pressed="attemptedNextRep"
              @click="attemptedNextRep = !attemptedNextRep"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
              <span class="wtEffortToggleLabel">{{ nextRepToggleLabel }}</span>
            </button>
            <!--
              The RPE pill is a DISCLOSURE that stays on screen holding the
              value and flipping its chevron, so the control that opens the
              scale is the control that closes it. It used to REPLACE itself
              with the scale, which left no visible way back — collapsing
              meant re-tapping the chip that was already selected, and nothing
              on screen suggested that. Tapping it no longer seeds a rating
              either: opening a picker is not choosing a value, and the old
              `selectedRPE = 7` recorded a 7 on any set where the row was
              opened and dismissed.
            -->
            <button
              type="button"
              :class="['wtRPEToggle', { wtRPEToggleSet: selectedRPE !== null }]"
              :aria-expanded="rpeExpanded"
              aria-controls="wtRPEScale"
              :aria-label="selectedRPE === null ? 'Add RPE rating' : `RPE ${formatRPE(selectedRPE)}`"
              @click="rpeExpanded = !rpeExpanded"
            >
              <svg v-if="selectedRPE === null" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>
              <span>{{ selectedRPE === null ? 'RPE' : `RPE ${formatRPE(selectedRPE)}` }}</span>
              <svg :class="['wtRPEChevron', { wtRPEChevronOpen: rpeExpanded }]" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
            </button>
          </div>

          <!--
            Five whole points plus a half-step modifier. Every half-point as
            its own chip needed 9 × 44pt = 428px of row in the 350px the sheet
            gives, so 9 / 9.5 / 10 sat off-screen behind an overflow scroller
            with no visible edge — three of the nine ratings were unreachable
            without a scroll gesture nothing hinted at. Six chips fit the width
            outright: every rating on the 6–10 scale is reachable in at most
            two taps and none of them hide.
          -->
          <div v-if="rpeExpanded" id="wtRPEScale" class="wtRPEScale">
            <div class="wtRPEPoints" role="radiogroup" aria-label="Rate of Perceived Exertion">
              <button
                v-for="v in RPE_POINTS"
                :key="v"
                type="button"
                :class="['wtRPEChip', { wtRPEChipActive: rpeBase === v }]"
                role="radio"
                :aria-checked="rpeBase === v"
                :aria-label="`RPE ${v}`"
                @click="setRPEPoint(v)"
              >{{ v }}</button>
            </div>
            <button
              type="button"
              :class="['wtRPEChip', 'wtRPEHalfChip', { wtRPEChipActive: rpeHalf }]"
              :disabled="!canHalfRPE"
              :aria-pressed="rpeHalf"
              aria-label="Half point"
              @click="toggleRPEHalf"
            >½</button>
          </div>

          <!-- One-time hint: plate calculator discoverability (LIFT-388) -->
          <div
            v-if="showPlateHint"
            class="wtPlateHint"
            role="button"
            tabindex="0"
            @click="openSettingsFromHint"
            @keydown.enter="openSettingsFromHint"
            @keydown.space.prevent="openSettingsFromHint"
          >
            <svg class="wtPlateHintIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
            <span class="wtPlateHintText">Tip: Enable the plate calculator in exercise settings</span>
            <button class="wtPlateHintDismiss" @click.stop="dismissPlateHint" aria-label="Dismiss hint">×</button>
          </div>

          <!--
            Plate calculator (shown when exercise is in plates mode).
            Matches screens/05-logset-platecalc.png:
            - Bordered card with header row: "PER SIDE · 45 LB BAR" + delta vs last
            - 5-column grid: gold +N pill on top, count, dim −N pill on bottom
            The weight value itself is rendered by the WEIGHT card above; this
            card is purely the plate-picker chrome.
          -->
          <div v-if="plateMode && !isEditMode" class="wtPlateCalc wtPlateCard">
            <div class="wtPlateCardHeader">
              <span class="wtPlateCardHeaderLabel">{{ isPerSide ? `PER SIDE · ${currentBarWeight} ${weightUnit} BAR` : `TOTAL · ${currentBarWeight} ${weightUnit} BAR` }}</span>
            </div>
            <div class="wtPlateGrid">
              <div v-for="denom in activeDenominations" :key="denom" class="wtPlateCol">
                <button class="wtPlateBtn wtPlateBtnAdd" @click="addPlate(denom)" :aria-label="`Add ${denom} ${weightUnit}`">+{{ denom }}</button>
                <div class="wtPlateCountBox" :class="{ wtPlateCountActive: plateCounts.get(denom) }">
                  <span class="wtPlateCountNum">{{ plateCounts.get(denom) || 0 }}</span>
                </div>
                <button class="wtPlateBtn wtPlateBtnRemove" :class="{ wtPlateBtnRemoveDim: !currentPlates.includes(denom) }" @click="removePlate(denom)" :disabled="!currentPlates.includes(denom)" :aria-label="`Remove ${denom} ${weightUnit}`">−{{ denom }}</button>
              </div>
            </div>
          </div>

          <!-- Actions (always last) -->
          <div class="repMaxActions">
            <button class="repMaxBtn repMaxBtnCalc" :disabled="!canSave" @click="saveSet">
              {{ isEditMode ? 'Save Changes' : (selectedExerciseId === '__new__' && !hasSetData ? 'Add Exercise' : (ghostArmed && nextRung ? `Save ${displayWeight(nextRung.weightLbs)} × ${nextRung.reps}` : 'Save')) }}
            </button>
            <button class="repMaxBtn repMaxBtnClose" @click="closeModal">{{ isEditMode ? 'Cancel' : 'Done' }}</button>
          </div>

        </template>
      </div>
    </div>
  </Teleport>


  <!-- Edit Exercise Modal (extracted to EditExerciseModal.vue) -->
  <EditExerciseModal
    :exercise="editTargetExercise"
    :all-tags="store.allTags"
    :all-gyms="allGyms"
    @create-gym="gymActions.createGym"
    @close="editTarget = null"
    @save="onEditExerciseSave"
    @archive="handleArchiveFromEdit"
    @unarchive="handleUnarchiveFromEdit"
    @delete="onEditExerciseDelete"
  />

  <!-- Exercise Picker (timeline + Log Set; extracted to ExercisePickerModal.vue) -->
  <ExercisePickerModal
    :open="timelineLogPicking"
    :exercises="exercisesByRecency"
    @close="timelineLogPicking = false"
    @select="pickExerciseForLog"
    @create-new="pickNewExerciseFromPicker"
  />

  <!-- Tag Manager Modal (extracted to TagManagerModal.vue) -->
  <TagManagerModal
    :open="tagManagerOpen"
    :all-tags="store.allTags"
    :exercises="liveExercises"
    @close="tagManagerOpen = false"
    @create-tag="store.addCustomTag"
    @rename-tag="onRenameTag"
    @delete-tag="confirmDeleteTag"
    @toggle-exercise-tag="store.toggleExerciseTag"
  />

  <!-- Gym Manager Modal (#961) — create/rename/delete gyms + bulk membership -->
  <GymManagerModal
    :open="gymManagerOpen"
    :gyms="allGyms"
    :exercises="liveExercises"
    @close="gymManagerOpen = false"
    @create-gym="gymActions.createGym"
    @rename-gym="onRenameGym"
    @delete-gym="gymActions.deleteGym"
    @toggle-exercise-gym="gymActions.toggleExerciseGym"
  />

  <!-- Rest timer bar -->
  <button
    v-if="restTimerEnabled && !showModal"
    class="wtRestBar"
    :class="{ wtRestBarActive: timerCtrl.timerActive.value && !showModal, wtRestBarUrgent: timerCtrl.timerUrgent.value && timerCtrl.timerActive.value && !showModal }"
    @click="openRestTimer"
  >
    <template v-if="timerCtrl.timerActive.value">
      <div class="wtRestBarProgress" :style="{ width: (timerCtrl.timerProgress.value * 100) + '%' }"></div>
      <svg class="wtRestBarIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="wtRestBarTime">{{ timerCtrl.timerDisplay.value }}</span>
      <span class="wtRestBarLabel">remaining</span>
    </template>
    <template v-else>
      <svg class="wtRestBarIcon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <span class="wtRestBarLabel">Start Rest Timer</span>
    </template>
  </button>

  <Teleport to="body">
    <WorkoutCompleteView
      v-if="workoutCompleteSummary"
      :summary="workoutCompleteSummary"
      @close="workoutCompleteDate = null"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted, defineAsyncComponent } from 'vue'
import { useWorkoutStore } from '../stores/workout'
import { buildSessionSummary } from '../lib/sessionSummary'
import { buildSessionPlan } from '../lib/sessionPlan'
import { todayISO, localDateKey, setDayKey, formatShortDate, daysBetweenISO } from '../lib/dates'

const WorkoutCompleteView = defineAsyncComponent(() => import('./WorkoutCompleteView.vue'))
import type { Exercise, WorkoutSet, PlateCountMode, UsualLadder, UsualLadderRung } from '../stores/workout'

import { useAnalytics } from '../composables/useAnalytics'
import { useTheme } from '../composables/useTheme'
import { useWeightUnit } from '../composables/useWeightUnit'
import { useRestTimer } from '../composables/useRestTimer'
import { useRestTimerController } from '../composables/useRestTimerController'
import { useUndoToast } from '../composables/useUndoToast'
import { useSwipeToDismiss } from '../composables/useSwipeToDismiss'
import { useModal } from '../composables/useModal'
import { useHaptics } from '../composables/useHaptics'
import { usePRBaseline } from '../composables/usePRBaseline'
import { usePRBurst } from '../composables/usePRBurst'
import { useFirstSetCelebration } from '../composables/useFirstSetCelebration'
import { useGoalCelebration } from '../composables/useGoalCelebration'
import { decideGoalCelebration, readGoalCelebrationState, markGoalWeekCelebrated } from '../lib/goalCelebration'
import { useProgressionStore } from '../stores/progression'
import { platesToWeight, weightToPlates, defaultBarWeight, LBS_PLATES, KG_PLATES, type PlateSet } from '../lib/plateCalculator'
import { generateIntensityTable, DEFAULT_INTENSITY_MAX_REPS, type IntensityRow } from '../lib/intensityTable'
import { applyStreakMultiplier, isExerciseEstablished, XP_CONFIG } from '../lib/xp'
import { epley } from '../lib/epley'
import { allowsZeroWeight, formatSetLoad, isLoggableWeight } from '../lib/bodyweightLoad'
import { scoreSet } from '../lib/setScoring'
import { useXPCeremony } from '../composables/useXPCeremony'
import { computeWeeklyGoal } from '../lib/weeklyGoal'
import ExerciseDetailModal from '../views/ExerciseDetailModal.vue'
import RestTimerContent from './RestTimerContent.vue'
import WorkoutTimeline from './WorkoutTimeline.vue'
import EditExerciseModal, { type EditExerciseSave } from './EditExerciseModal.vue'
import TagManagerModal from './TagManagerModal.vue'
import GymManagerModal from './GymManagerModal.vue'
import ExercisePickerModal from './ExercisePickerModal.vue'
import { useGymActions } from '../composables/useGymActions'
import { scrollInputAboveKeyboard } from '../lib/keyboardViewport'
import { ladderChipScrollLeft } from '../lib/ladderScroll'
import { MAX_WEIGHT, MAX_REPS } from '../lib/inputLimits'
import { loadJSON } from '../lib/storage'
import { matchesGymFilter, loadActiveGymFilter, saveActiveGymFilter, sanitizeGymName, MAX_GYMS, GYM_NAME_MAX_LENGTH } from '../lib/gyms'

const store = useWorkoutStore()
const progressionStore = useProgressionStore()
const { logEvent } = useAnalytics()
const { show: showUndo } = useUndoToast()
const { currentTheme } = useTheme()
const { restTimerEnabled, restTimerAutoStart } = useRestTimer()
const { weightUnit, displayWeight, toLbs } = useWeightUnit()
const { impactLight, notifySuccess } = useHaptics()
const { logSetXPCeremony } = useXPCeremony()
const { prBaselineDate, strengthBaselineMode } = usePRBaseline()
const { presentPRBurst } = usePRBurst()

// Labels that name the baseline in force (#1272). Every "best" the log sheet
// shows — the intensity anchor, the live estimate, the to-beat card — is
// `getExercisePR(id, prBaselineDate)`, which in recent mode is a rolling window
// rather than the all-time peak. Calling a recent best a "PR" would misreport
// it, so the copy follows the mode.
const isRecentBaseline = computed(() => strengthBaselineMode.value === 'recent')
const baselineMaxLabel = computed(() => (isRecentBaseline.value ? 'recent max' : 'max'))
const baselineBestLabel = computed(() => (isRecentBaseline.value ? 'Recent best' : 'Best'))
const prTargetLabel = computed(() =>
  isRecentBaseline.value ? 'To Beat Your Recent Best' : 'To Beat Your Est. 1RM',
)
const prBadgeLabel = computed(() => (isRecentBaseline.value ? 'New recent best! 🏆' : 'New PR! 🏆'))
const { presentFirstSetCelebration } = useFirstSetCelebration()
const { presentGoalCelebration } = useGoalCelebration()

// One-time activation flag (#762): celebrate a brand-new user's first ever set.
const FIRST_SET_FLAG = 'first-set-celebrated'

// Rest timer controller — all timer state and logic extracted into composable
const timerCtrl = useRestTimerController(
  () => { skipToNextSet() },
  showUndo,
)

// Screen Wake Lock — keep display on during active workouts
import { useWakeLock } from '../composables/useWakeLock'
import { usePreferencesStore } from '../stores/preferences'
import { searchExerciseDatabase } from '../lib/exerciseDatabase'
import type { ExerciseEntry } from '../lib/exerciseDatabase'
const _prefs = usePreferencesStore()
const wakeLockEnabled = computed(() => _prefs.experience.screenWakeLock !== false)

function computeAndLogXP(exerciseId: string, setId: string, estimated1RM: number, weight: number, reps: number) {
  const exercise = store.exercises.find(e => e.id === exerciseId)
  if (!exercise) return

  // Score against existing sets (the just-logged set is already in the array).
  const otherSets = exercise.sets.filter(s => s.id !== setId)
  const { best1RM, isPR, isTie, isRepPR, zone, baseXP } = scoreSet({
    priorSets: otherSets,
    estimated1RM,
    weightLbs: weight,
    reps,
    dateKey: date.value || todayISO(),
    baseline: prBaselineDate.value,
  })

  const mult = progressionStore.currentMultiplier
  let xp = applyStreakMultiplier(baseXP, progressionStore.streakHistory, new Date().toISOString())
  // If no history entry for current week, apply currentMultiplier directly
  if (xp === baseXP && mult > 1) {
    xp = Math.round(baseXP * mult)
  }
  logSetXPCeremony({
    setId,
    exerciseId,
    xp,
    baseXP,
    zone,
    isPR,
    isTie,
    isRepPR,
    activeTheme: currentTheme.value,
    estimated1RM,
    exerciseBest1RM: best1RM,
    streakMultiplier: mult,
    onUnlock: notifySuccess,
  })
}

// ── Fresh-start transition card ─────────────────────────────────
// Shown after user clears sample data, dismissed on first exercise add
const showFreshStart = ref(localStorage.getItem('fresh-start') === 'true')
function onFreshStart() { showFreshStart.value = true }
onMounted(() => { window.addEventListener('fresh-start', onFreshStart) })
onUnmounted(() => { window.removeEventListener('fresh-start', onFreshStart) })
watch(() => store.exercises.length, (len) => {
  if (len > 0 && showFreshStart.value) {
    localStorage.removeItem('fresh-start')
    showFreshStart.value = false
  }
})

// ── View toggle ──────────────────────────────────────────────────
const listView = ref<'exercises' | 'timeline'>(
  (localStorage.getItem('wt-list-view') as 'exercises' | 'timeline') || 'exercises'
)
watch(listView, v => localStorage.setItem('wt-list-view', v))

// ── Timeline view (extracted to WorkoutTimeline.vue) ────────────
/** Timeline rows carry only the exercise id — resolve it before opening the edit modal. */
function onTimelineEditSet(exerciseId: string, set: WorkoutSet) {
  const exercise = store.exercises.find(e => e.id === exerciseId)
  if (exercise) openEditModal(exercise, set)
}

// ── Fresh-identity child bindings (#963) ─────────────────────────
// The store mutates exercises IN PLACE behind a shallowRef and signals via
// triggerRef, so the raw array's identity never changes. A child bound
// straight to `store.exercises` freezes: on each mutation the parent
// re-renders, Vue compares the child's props by identity, and skips it.
// Children that must observe mutations while mounted (the timeline, the
// tag/gym manager checklists) bind this computed instead — re-slicing on
// every store trigger gives the prop a fresh identity.
const liveExercises = computed(() => [...store.exercises])

// ── Gym filtering (#961) ─────────────────────────────────────────
// Exclusive (AND) filter applied BEFORE the additive tag filter: pick the gym
// you're training at and exercises assigned only to other gyms disappear.
// The gym list is a synced preference; the ACTIVE selection is device-local
// ("which gym am I at" doesn't belong on other devices).
const allGyms = computed(() => _prefs.gyms)
const activeGymFilter = ref<string | null>(loadActiveGymFilter())

/**
 * The filter actually applied. A persisted selection is only honored once the
 * gym exists in the (async-hydrated) list — before hydration, and for a gym
 * deleted on another device, the filter is inert rather than hiding rows.
 */
const effectiveGymFilter = computed(() =>
  activeGymFilter.value && allGyms.value.includes(activeGymFilter.value)
    ? activeGymFilter.value
    : null
)

/** Active exercises narrowed to the effective gym — the base for every list surface. */
const gymFilteredExercises = computed(() => {
  const gym = effectiveGymFilter.value
  if (!gym) return store.activeExercises
  return store.activeExercises.filter(e => matchesGymFilter(e.gyms, gym, allGyms.value))
})

function toggleGymFilter(gym: string) {
  // Exclusive select: tapping the active gym deselects back to "All Gyms".
  activeGymFilter.value = activeGymFilter.value === gym ? null : gym
}

watch(activeGymFilter, saveActiveGymFilter)

// Reset a stale selection when its gym is renamed/deleted. Only prune against
// a NON-EMPTY list: during the pre-hydration window the list is [] and pruning
// would wipe the persisted device-local selection (effectiveGymFilter already
// keeps the filter inert until the gym exists).
watch(allGyms, (gyms) => {
  if (gyms.length > 0 && activeGymFilter.value && !gyms.includes(activeGymFilter.value)) {
    activeGymFilter.value = null
  }
})

// ── Search & tag filtering ──────────────────────────────────────
const searchQuery = ref('')
const activeTagFilters = ref<string[]>([])

/**
 * Screen-reader confirmation for the set-save path (#1148, WCAG 2.2 SC 4.1.3
 * Status Messages). The log-set modal stays open with cleared fields after a
 * save, so a sighted user sees the freshly-emptied form as feedback, but a
 * blind user gets nothing — no toast, no focus move, no announcement. This
 * string feeds a persistent polite live region inside the modal; `announceSet`
 * sets it (clearing first so an identical re-log still re-fires the region).
 */
const setLogAnnouncement = ref('')
function announceSet(message: string) {
  setLogAnnouncement.value = ''
  nextTick(() => { setLogAnnouncement.value = message })
}

/**
 * Tag chips visible in the filter row. When the user is searching we narrow
 * the row to tags that match the query (so typing "shoulders" also filters
 * the chips), plus any currently-active tag so the user can see + toggle it
 * back off without clearing the search first.
 */
const filteredTags = computed<string[]>(() => {
  // Only surface tags that exist on at least one active (non-archived)
  // exercise. Otherwise tapping a chip filters to an empty list because the
  // archived section is hidden whenever a filter is active.
  const activeTags = store.allTags.filter(t => (tagCounts.value[t] || 0) > 0)
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return activeTags
  return activeTags.filter(t =>
    t.toLowerCase().includes(q) || activeTagFilters.value.includes(t)
  )
})

function toggleTagFilter(tag: string) {
  // Tapping a tag chip commits the user's intent: clear the search and apply
  // the tag as a filter. If the tag was already active, tapping deactivates it.
  const wasActive = activeTagFilters.value.includes(tag)
  searchQuery.value = ''
  if (wasActive) {
    activeTagFilters.value = activeTagFilters.value.filter(t => t !== tag)
  } else {
    activeTagFilters.value = [...activeTagFilters.value, tag]
  }
}

/** "All" chip — clear both the search and any active tags. */
function clearSearchAndTags() {
  searchQuery.value = ''
  activeTagFilters.value = []
}

/**
 * Most recent activity day-key per exercise — the max `setDayKey` across all
 * of its sets, INCLUDING today (a set logged today floats the exercise to the
 * top). Exercises never logged map to '' and sort to the bottom. Built once
 * per set-data change so the recency sort in `filteredExercises` stays
 * O(n·log n) rather than O(n·m) rescanned on every render. (#936)
 */
const lastActivityByExercise = computed(() => {
  const map = new Map<string, string>()
  for (const ex of store.activeExercises) {
    let latest = ''
    for (const s of ex.sets) {
      const day = setDayKey(s.date)
      if (day > latest) latest = day
    }
    map.set(ex.id, latest)
  }
  return map
})

/**
 * Sort a list of exercises by most-recent activity (descending) without
 * mutating the input. `.sort` is stable, so equal-recency exercises (including
 * never-logged, key '') keep their incoming order, preserving any manual
 * drag/keyboard reorder as a tiebreaker. (#936)
 */
function sortByRecency(list: readonly Exercise[]): Exercise[] {
  const activity = lastActivityByExercise.value
  return list.slice().sort((a, b) => {
    const ka = activity.get(a.id) ?? ''
    const kb = activity.get(b.id) ?? ''
    if (ka === kb) return 0
    return ka < kb ? 1 : -1
  })
}

/**
 * Active exercises ordered by recency, with no search/tag filter — feeds the
 * "Choose Exercise" quick-log picker so the next exercise to train sits at the
 * top of that list too. (#936) Gym-scoped (#961): the picker exists to answer
 * "what am I logging right now?", so it respects the active gym like the list.
 */
const exercisesByRecency = computed(() => sortByRecency(gymFilteredExercises.value))

const filteredExercises = computed(() => {
  // Gym filter first (#961) — exclusive AND; search/tags narrow within it.
  let result = gymFilteredExercises.value
  // Text search — check both name and tags so "Push" matches tag-filtered rows.
  const q = searchQuery.value.trim().toLowerCase()
  if (q) {
    result = result.filter(e => {
      if (e.name.toLowerCase().includes(q)) return true
      const tags = e.tags || []
      return tags.some(t => t.toLowerCase().includes(q))
    })
  }
  // Tag filter
  if (activeTagFilters.value.length > 0) {
    result = result.filter(e => {
      const tags = e.tags || []
      return activeTagFilters.value.some(t => tags.includes(t))
    })
  }
  // Recency ordering (#936): most recently logged exercise first, so the next
  // exercise to perform is the easiest to reach. Applied AFTER filtering so
  // tag / search subsets stay recency-ordered too — the most recent exercise
  // within a muscle group floats to the top of that filtered view.
  return sortByRecency(result)
})

/**
 * Screen-reader announcement for the live search-result count (#989, WCAG 2.2
 * SC 4.1.3 Status Messages). The visible `.wtSearchCount` badge is aria-hidden
 * and only mounts while typing, so it can't reliably announce; this string
 * feeds a persistent polite live region that voices the tally as the query
 * narrows. Empty while no query is active so nothing is spoken on clear.
 */
const searchResultAnnouncement = computed(() => {
  if (!searchQuery.value) return ''
  const n = filteredExercises.value.length
  return `${n} result${n !== 1 ? 's' : ''}`
})

/**
 * True when the list is showing a filtered subset of exercises (either a
 * text search query or one-or-more active tag filters). Long-press
 * reorder is disabled in this state because `v-for` gives us indices
 * into the filtered subset, and those indices are meaningless to the
 * store, which splices the unfiltered `exercises` array. Dropping a
 * filtered-index 0 row would move the absolute-index 0 row — usually
 * a completely different exercise the user can't even see.
 *
 * Fixes: reordering while searching silently scrambled unrelated rows
 * (previously only the tag-filter path was gated).
 */
const isFilteringActive = computed(() =>
  activeTagFilters.value.length > 0 || searchQuery.value.trim() !== '' || effectiveGymFilter.value !== null
)

// ── Guided session plan (#1256) ─────────────────────────────────
/**
 * Scope for the "repeat last session" plan: gym + tag filtered, WITHOUT the
 * search query and WITHOUT the recency sort. Search means "find one specific
 * exercise" (the card hides there), and the today-inclusive recency sort
 * reshuffles as sets land — a just-logged exercise would jump to the top of
 * the plan mid-workout. Store order is stable, so rows stay put.
 */
const planScopeExercises = computed(() => {
  const result = gymFilteredExercises.value
  if (activeTagFilters.value.length === 0) return result
  return result.filter(e => {
    const tags = e.tags || []
    return activeTagFilters.value.some(t => tags.includes(t))
  })
})

const sessionPlan = computed(() => buildSessionPlan(planScopeExercises.value, todayISO()))

const sessionPlanExpanded = ref(false)
const sessionPlanListId = 'wt-session-plan-list'

/** "Repeat last Push session" when exactly one tag filter narrows the scope. */
const sessionPlanLabel = computed(() =>
  activeTagFilters.value.length === 1
    ? `Repeat last ${activeTagFilters.value[0]} session`
    : 'Repeat last session'
)

/** Reference day, formatted via local midnight (a bare YYYY-MM-DD in
 *  `new Date` parses as UTC and renders yesterday for US timezones). */
const sessionPlanDayLabel = computed(() => {
  const plan = sessionPlan.value
  if (!plan) return ''
  return new Date(plan.day + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
})

function toggleSessionPlan() {
  sessionPlanExpanded.value = !sessionPlanExpanded.value
  if (sessionPlanExpanded.value) {
    logEvent('session_plan_expanded', { exercises: sessionPlan.value?.items.length ?? 0 })
  }
}

function logFromSessionPlan(exerciseId: string) {
  logEvent('session_plan_item_tapped', {})
  openLogForExercise(exerciseId)
}

/** Total exercise count, shown in the "Workouts" header stats. */
const totalExercises = computed(() => store.activeExercises.length)

/**
 * Sets logged on the local "today" date — drives the Finish workout affordance.
 * Reads the store's sets-per-day index rather than rescanning every set on each
 * `triggerRef(exercises)`, i.e. on every logged set (LIFT-1237).
 */
const setsLoggedToday = computed(() => store.setsLoggedOn(todayISO()))

/** When non-null, renders the WorkoutCompleteView overlay for that date. */
const workoutCompleteDate = ref<string | null>(null)
const workoutCompleteSummary = computed(() => {
  const d = workoutCompleteDate.value
  if (!d) return null
  return buildSessionSummary({
    rawDate: d,
    exercises: store.exercises,
    xpPerSet: progressionStore.xpPerSet,
    streakWeeks: progressionStore.streakWeeks,
    toDisplayUnits: displayWeight,
    unitLabel: weightUnit.value,
  })
})
function openWorkoutComplete() {
  workoutCompleteDate.value = todayISO()
  impactLight()
  logEvent('workout_complete_view_opened', { sets: setsLoggedToday.value })
}

/** Exercises whose baseline-relative PR was achieved in the last 7 days. */
const prsThisWeek = computed(() => {
  const now = Date.now()
  const weekAgo = now - 7 * 86400000
  let count = 0
  for (const e of store.exercises) {
    const pr = store.getExercisePRSet(e.id, prBaselineDate.value)
    if (pr && new Date(pr.date).getTime() >= weekAgo) count++
  }
  return count
})

/**
 * Weekly goal indicator — counts unique training days in the current Mon–Sun week
 * and compares against the user's weeklyTarget from the progression store.
 * Returns null when progression is disabled (indicator hidden).
 */
const weeklyGoalInfo = computed(() => {
  if (!progressionStore.progressionEnabled) return null
  return computeWeeklyGoal(store.exercises, progressionStore.weeklyTarget)
})

/**
 * Consecutive-week streak count (LIFT-1109). `streakWeeks` reflects completed
 * Mon–Sun weeks that met the target and is otherwise only surfaced on share
 * cards; a streak reinforces the habit in proportion to how often it's seen, so
 * mirror it into the header. 0 → hidden (no streak to lose yet). Gated by the
 * same `progressionEnabled` flag as the goal banner it lives in.
 */
const weekStreak = computed(() => {
  if (!progressionStore.progressionEnabled) return 0
  return progressionStore.streakWeeks
})

/**
 * Fire the weekly-goal celebration the first time the goal is met each week
 * (LIFT-764). Called after a set is logged. Skipped while a PR burst is showing
 * so the two overlays never stack — the week is left unmarked so the
 * celebration still fires on the next non-PR set. The once-per-week guard lives
 * in device-local storage, mirroring the overload nudge.
 *
 * Returns `true` when a celebration (and its success/milestone haptic) actually
 * fired, so the caller can suppress the routine light tap and avoid two native
 * haptics colliding into a muddy buzz on Capacitor/iOS.
 */
function maybeCelebrateWeeklyGoal(prShown: boolean): boolean {
  if (prShown) return false
  const info = weeklyGoalInfo.value
  if (!info) return false
  const state = readGoalCelebrationState()
  const decision = decideGoalCelebration(info.met, progressionStore.streakWeeks, state.lastCelebratedWeek)
  if (!decision) return false
  markGoalWeekCelebrated(decision.weekKey)
  const celebrated = presentGoalCelebration({ streak: decision.streak, milestone: decision.milestone, target: info.target })
  logEvent('weekly_goal_celebrated', { streak: decision.streak, milestone: decision.milestone })
  // A streak-tier crossing (2/4/8/12-week multiplier bump) is a distinct
  // progression-depth signal from simply hitting the weekly goal — emit a
  // dedicated event so streak retention is filterable in the dashboard (#796).
  if (decision.milestone) {
    logEvent('streak_milestone', { streak: decision.streak, target: info.target })
  }
  return celebrated
}

/**
 * Count of exercises carrying each tag — powers the "Push 23" suffix on tag
 * chips. Counts only active (non-archived) exercises — narrowed to the active
 * gym (#961) — so that the chip count matches what tapping the tag will
 * actually show. Tags that exist solely on archived exercises are filtered
 * out by `filteredTags` below.
 */
const tagCounts = computed<Record<string, number>>(() => {
  const map: Record<string, number> = {}
  for (const e of gymFilteredExercises.value) {
    for (const t of e.tags || []) {
      map[t] = (map[t] || 0) + 1
    }
  }
  return map
})

/**
 * Per-row presentation data for the main exercise list: last set summary,
 * time-ago, and whether the current baseline-relative PR was set this week
 * (drives the "NEW PR" gold badge in the card).
 */
/**
 * A stored set's load in the words the history surfaces use — "Bodyweight",
 * "+25 lbs", "135 lbs" (LIFT-1373). The exercise-row meta and the post-save
 * announcement both read a set back, so both go through the one formatter.
 */
function setLoadLabel(
  set: { weight: number; bodyweight?: number },
  exercise?: Pick<Exercise, 'bodyweightLoaded'> | null,
): string {
  return formatSetLoad(set, exercise, { displayWeight, unit: weightUnit.value })
}

interface ExerciseRowMeta {
  /** Pre-formatted load (LIFT-1373) — "Bodyweight", "+25 lbs", "135 lbs". */
  lastSet: { load: string; reps: number; date: string } | null
  timeAgo: string | null
  isNewPRBadge: boolean
}

function computeRowMeta(ex: Exercise): ExerciseRowMeta {
  if (ex.sets.length === 0) return { lastSet: null, timeAgo: null, isNewPRBadge: false }
  const last = ex.sets[ex.sets.length - 1]
  const prSet = store.getExercisePRSet(ex.id, prBaselineDate.value)
  const isFreshPR = !!prSet && (Date.now() - new Date(prSet.date).getTime()) < 7 * 86400000
  return {
    lastSet: { load: setLoadLabel(last, ex), reps: last.reps, date: last.date },
    timeAgo: formatTimeAgo(last.date),
    isNewPRBadge: isFreshPR,
  }
}

/**
 * Per-row meta for every visible exercise, computed once per render pass and
 * keyed by id (#1112). The template reads each row's meta up to 5× (badge, last
 * set weight/reps, time-ago); computing it here — instead of calling a helper
 * per template binding — collapses the per-row `getExercisePRSet` + date math
 * from 5 invocations down to 1. Recomputes only when the visible list, the PR
 * baseline, or a set changes (all reactive deps below).
 */
const rowMetaByExercise = computed<Record<string, ExerciseRowMeta>>(() => {
  const map: Record<string, ExerciseRowMeta> = {}
  for (const ex of filteredExercises.value) {
    map[ex.id] = computeRowMeta(ex)
  }
  return map
})

// Remove stale tags from active filters
watch(() => store.allTags, (tags) => {
  activeTagFilters.value = activeTagFilters.value.filter(t => tags.includes(t))
})

// ── Exercise detail modal (extracted to ExerciseDetailModal.vue) ──
const detailExerciseId = ref<string | null>(null)

// ── Swipe-to-dismiss for log-set sheet (step 5f) ────────────────
// Drag the handle (or the sheet body, when not scrolled) down past
// 100px to close the sheet. Uses the same composable as the detail
// modal so the gesture feels consistent across the app.
const logSheetEl = ref<HTMLElement | null>(null)
const logSheetHandleEl = ref<HTMLElement | null>(null)
const logSwipe = useSwipeToDismiss({
  threshold: 100,
  onDismiss: () => closeModal(),
})

function openDetailModal(id: string) {
  // Opening any exercise is exactly the action the explore-path chart tip
  // encourages, so retire it once the user has done so (LIFT-1086).
  if (hasSampleData.value && !chartTipDismissed.value) dismissChartTip()
  detailExerciseId.value = id
}

// From the log-set modal header: jump to the exercise's set history.
// The log sheet and detail modal share a z-index, so this is a swap
// (close the sheet, open the detail) rather than a stack. The detail
// modal's "+ Log Set" footer is the labelled path back to logging.
function openHistoryFromLog() {
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return
  closeModal()
  openDetailModal(id)
}

/** Relative time string used on the main exercise list ("today", "yesterday", "4 days ago"). */
function formatTimeAgo(iso: string): string {
  const now = new Date()
  const then = new Date(iso)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfThen = new Date(then.getFullYear(), then.getMonth(), then.getDate()).getTime()
  const days = Math.round((startOfToday - startOfThen) / 86400000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  return formatShortDate(iso)
}

// ── Log / Edit modal state ────────────────────────────────────────
const weightInputEl = ref<HTMLInputElement | null>(null)
const showModal = ref(false)

const editingSet = ref<{ exerciseId: string; setId: string } | null>(null)
const selectedExerciseId = ref('')

// ── Last session for quick-fill ──────────────────────────────────
const lastSession = computed(() => {
  return store.getLastSession(selectedExerciseId.value, todayISO())
})

// Track which last-session sets the user has already tapped (visual feedback)
const lastSessionUsed = ref<Record<number, boolean>>({})

function fillFromLastSession(set: { weight: number; reps: number }, index: number) {
  weightStr.value = String(displayWeight(set.weight))
  repsStr.value = String(set.reps)
  lastSessionUsed.value = { ...lastSessionUsed.value, [index]: true }
}

// ── Intensity lens: PR/1RM-anchored weight × reps table (#770) ─────
// A slider picks an intensity (% of the exercise's best e1RM); the table shows,
// per rep count, the lightest LOADABLE weight whose e1RM MEETS OR BEATS that
// intensity (ceiled to a plate increment). Ceiling is what lets one lens span
// warmups (low %) through PR-beating loads (100%) — the former separate "PR"
// table is just this table read at 100%. Reps are NOT prescribed — the user
// taps the row matching their planned reps; each row carries its e1RM.
const INTENSITY_DEFAULT_PCT = 80
const INTENSITY_STEP = 5
const intensityPct = ref(INTENSITY_DEFAULT_PCT)
const intensityUsed = ref<Record<number, boolean>>({})

// `intensityUsed` is keyed by row index; moving the slider rebuilds the table
// with new weights at the same indices, so a stale "used" highlight would lie.
// Clear it whenever the intensity changes.
watch(intensityPct, () => { intensityUsed.value = {} })

// Anchor: the exercise's best e1RM (its PR) — same source as the PR lens.
const intensityOneRM = computed<number | null>(() => {
  if (isEditMode.value || !isLogForExercise.value) return null
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null
  const pr = store.getExercisePR(id, prBaselineDate.value)
  return pr > 0 ? pr : null
})

const intensityMaxReps = computed<number>(() => {
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  return ex?.intensityMaxReps ?? DEFAULT_INTENSITY_MAX_REPS
})

// Global, user-configured intensity presets (Settings → Intensity Presets, #776).
// Rendered as tappable chips above the slider; tapping one sets intensityPct.
const intensityPresets = computed<number[]>(() => _prefs.intensityPresets)

const intensityTable = computed<IntensityRow[]>(() => {
  const oneRM = intensityOneRM.value
  if (oneRM === null) return []
  // The generator works in DISPLAY units — the same space as the bar and the
  // denominations it is handed (LIFT-1211). The canonical-lbs PR crosses that
  // boundary here and nowhere else: passing it raw alongside a kg bar and kg
  // plates mixed the two spaces, so a kg row labelled 69.2 filled the field
  // with 152.5 and one tap could save a fake all-time PR (LIFT-1315).
  return generateIntensityTable(displayWeight(oneRM), intensityPct.value, {
    barWeight: currentBarWeight.value,
    perSide: isPerSide.value,
    denominations: activeDenominations.value,
    maxReps: intensityMaxReps.value,
    plateMode: plateMode.value,
    unit: weightUnit.value,
    // The anchor is an EFFECTIVE 1RM but each row is filled into the weight
    // field, which means ADDED weight — the generator subtracts the fold before
    // it ceils so the number it hands back is actually loadable (#1328). The
    // fold is canonical lbs and crosses into display units here, the same
    // boundary the 1RM crosses above; passing it raw would re-create exactly the
    // mixed-space bug LIFT-1315 fixed (a kg user's 180 lb bodyweight read as
    // 180 kg of base load, emptying the table).
    baseLoad: displayWeight(bodyweightFoldLbs.value),
  })
})

// ── Consolidated "Suggestions" drawer (#759 / #770) ───────────────
// One segmented disclosure over every "what should my next set be?" lens —
// routine ladder / last-session quick-fill and the PR-anchored intensity table
// (which spans warmups → PR-beating at 100%) — instead of stacked cards.
// `suggestionLenses` (defined after the lenses' source computeds) lists what's
// available; `currentLens` self-heals if the selected lens loses its data. The
// drawer opens expanded on the quick-fill lens (routine/last) so the one-tap
// ghost-arm flow is never a tap away.
type SuggestionLens = 'routine' | 'last' | 'intensity'
const suggestionsExpanded = ref(false)
const activeLens = ref<SuggestionLens>('routine')

/** Load an intensity row into the inputs (mirrors fillFromRung's plate handling). */
function fillFromIntensity(row: IntensityRow, index: number) {
  if (plateMode.value && row.plates) {
    currentPlates.value = [...row.plates]
    syncPlateWeight()
  } else {
    // Already display units — the same space weightStr is read in.
    weightStr.value = String(row.weight)
  }
  repsStr.value = String(row.reps)
  intensityUsed.value = { ...intensityUsed.value, [index]: true }
  impactLight()
}

// ── Usual ladder: routine-aware quick-fill + ghost logging (#741) ──
// Captured once per modal open so the ladder never reshuffles mid-session
// (detection excludes today, so re-opening between sets yields the same rungs).
const usualLadder = ref<UsualLadder | null>(null)

// Mirrors the store's clustering tolerance — absorbs kg↔lbs float drift.
const LADDER_MATCH_TOLERANCE = 1.0

const ladderActive = computed(() =>
  usualLadder.value !== null &&
  !isEditMode.value &&
  isLogForExercise.value &&
  date.value === todayISO()
)

type RungState = 'done' | 'next' | 'skipped' | 'upcoming'

// Doneness is derived entirely from today's logged sets in the store — it
// survives modal close/reopen, set edits, and deletes with zero local state.
const rungStates = computed<RungState[]>(() => {
  if (!ladderActive.value) return []
  const rungs = usualLadder.value!.rungs
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  const today = todayISO()
  const todaySets = ex ? ex.sets.filter(s => setDayKey(s.date) === today) : []

  // Each today-set consumes the first pending rung within tolerance.
  const done = rungs.map(() => false)
  let maxTodayWeight = -Infinity
  for (const s of todaySets) {
    if (s.weight > maxTodayWeight) maxTodayWeight = s.weight
    for (let i = 0; i < rungs.length; i++) {
      if (!done[i] && Math.abs(rungs[i].weightLbs - s.weight) <= LADDER_MATCH_TOLERANCE) {
        done[i] = true
        break
      }
    }
  }
  // Beating the top rung (e.g. accepting the overload nudge) also completes it.
  const lastIdx = rungs.length - 1
  if (!done[lastIdx] && todaySets.some(s => s.weight >= rungs[lastIdx].weightLbs - LADDER_MATCH_TOLERANCE)) {
    done[lastIdx] = true
  }
  // Pending rungs lighter than today's heaviest are moot warm-ups → skipped.
  // Strict inequality keeps remaining repeat top-set rungs (e.g. 2nd of 3×225) pending.
  const states: RungState[] = rungs.map((rung, i) =>
    done[i] ? 'done'
      : todaySets.length > 0 && rung.weightLbs < maxTodayWeight - LADDER_MATCH_TOLERANCE ? 'skipped'
      : 'upcoming'
  )
  const nextIdx = states.indexOf('upcoming')
  if (nextIdx !== -1) states[nextIdx] = 'next'
  return states
})

const nextRungIndex = computed(() => rungStates.value.indexOf('next'))
const nextRung = computed<UsualLadderRung | null>(() => {
  const i = nextRungIndex.value
  return i >= 0 ? usualLadder.value!.rungs[i] : null
})

const ladderDoneCount = computed(() =>
  rungStates.value.filter(s => s === 'done' || s === 'skipped').length
)

const ladderLabel = computed(() => {
  if (!usualLadder.value) return ''
  const total = usualLadder.value.rungs.length
  return ladderDoneCount.value === 0
    ? `Usual · ${total} sets`
    : `Usual · ${ladderDoneCount.value} of ${total}`
})

function fillFromRung(rung: UsualLadderRung) {
  if (plateMode.value) {
    // Rung weights are canonical lbs; the plate layer works in display units.
    const plates = platesForWeight(displayWeight(rung.weightLbs))
    if (plates) {
      currentPlates.value = plates
      syncPlateWeight()
    }
  } else {
    weightStr.value = String(displayWeight(rung.weightLbs))
  }
  repsStr.value = String(rung.reps)
  impactLight()
}

// Ghost prefill: with both fields empty the next rung shows as input
// placeholders and Save commits it directly — one tap per habitual set.
// Typing anything disarms it. Fields stay genuinely empty, so the settled
// "fields cleared after save" pattern holds.
//
// Two extra disarm conditions guard the tap-tap-tap flow:
// - ghostJustSaved: brief cooldown after a ghost save so an iOS double-tap
//   can't silently log two rungs (the settled pattern's implicit guard —
//   fields cleared → Save disabled — doesn't exist on the ghost path).
// - overloadNudge visible: the nudge offers a heavier payload than the armed
//   rung; presenting both would put two near-identical numbers with opposite
//   tap semantics side by side. Save disarms until the user chooses (tap the
//   nudge card, tap a chip, or type).
const ghostJustSaved = ref(false)
let _ghostRearmTimer: ReturnType<typeof setTimeout> | null = null
const GHOST_REARM_MS = 500

const ghostArmed = computed(() =>
  ladderActive.value &&
  nextRung.value !== null &&
  weightStr.value === '' &&
  repsStr.value === '' &&
  !plateMode.value &&
  !ghostJustSaved.value &&
  overloadNudge.value === null
)

// Keep the highlighted "next" chip visible as the user works up the ladder.
// HORIZONTAL ONLY: scrollIntoView() would scroll every ancestor, including the
// vertical modal — yanking the inputs (and the just-saved confirmation) off
// screen after each save (#780). We scroll the chip row by itself instead.
const ladderChipsEl = ref<HTMLElement | null>(null)
watch(nextRungIndex, async (idx) => {
  if (idx < 0 || !showModal.value) return
  await nextTick()
  const container = ladderChipsEl.value
  const el = container?.querySelector<HTMLElement>('.wtPrevSessionChipNext')
  if (!container || !el) return
  const delta = ladderChipScrollLeft(
    container.getBoundingClientRect(),
    el.getBoundingClientRect(),
  )
  if (delta === 0) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  container.scrollBy({ left: delta, behavior: reduced ? 'auto' : 'smooth' })
})

// ── Overload nudge: rate-limited "go heavier" suggestion (#741) ───
// Surfaces only at the natural decision point — the habitual top set is up
// next — and only for high-confidence suggestions. Device-local UX state
// (PLATE_HINT_KEY precedent): deliberately NOT in preferences (would enter
// the Supabase sync payload) and NOT on Exercise (would trip LWW merge).
const NUDGE_STORAGE_KEY = 'overload-nudge-state'
// Suggested weight sits one store increment (5 lbs) above the habitual top set.
const NUDGE_WEIGHT_INCREMENT = 5
const NUDGE_BREAK_DAYS = 21
// Cooldown ladder indexed by ignoredCount; ≥3 ignores mutes the exercise
// until its habitual top weight actually changes (the silent escape hatch).
const NUDGE_COOLDOWNS = [7, 14, 28]

interface NudgeExerciseState {
  lastShownDay: string
  shownForWeightLbs: number
  outcome: 'pending' | 'accepted' | 'ignored'
  ignoredCount: number
}
interface NudgeState {
  lastGlobalShownDay: string
  byExercise: Record<string, NudgeExerciseState>
}

// Bumped on every write so the gate computed re-reads localStorage.
const nudgeStateVersion = ref(0)

function readNudgeState(): NudgeState {
  // Corrupted state falls back to fresh.
  return loadJSON<NudgeState>(NUDGE_STORAGE_KEY, { lastGlobalShownDay: '', byExercise: {} })
}

function writeNudgeState(state: NudgeState) {
  localStorage.setItem(NUDGE_STORAGE_KEY, JSON.stringify(state))
  nudgeStateVersion.value++
}

/**
 * Settles a pending nudge outcome lazily at modal open. Merely closing the
 * modal or skipping a day is NOT an ignore — only a later session whose top
 * set stayed below the suggestion counts. Also forgives a muted exercise
 * once its habitual top weight actually moves.
 */
function settleNudgeOutcome(exerciseId: string) {
  const state = readNudgeState()
  const mine = state.byExercise[exerciseId]
  if (!mine) return
  let changed = false

  if (mine.outcome === 'pending' && mine.lastShownDay !== todayISO()) {
    const ex = store.exercises.find(e => e.id === exerciseId)
    const topByDay = new Map<string, number>()
    for (const s of ex?.sets ?? []) {
      const day = setDayKey(s.date)
      if (day <= mine.lastShownDay) continue
      topByDay.set(day, Math.max(topByDay.get(day) ?? 0, s.weight))
    }
    // The user's next session after the nudge answers "did they take it?"
    const firstDayAfter = [...topByDay.keys()].sort()[0]
    if (firstDayAfter !== undefined) {
      const top = topByDay.get(firstDayAfter)!
      if (top >= mine.shownForWeightLbs - LADDER_MATCH_TOLERANCE) {
        mine.outcome = 'accepted'
        mine.ignoredCount = 0
      } else {
        mine.outcome = 'ignored'
        mine.ignoredCount++
      }
      changed = true
    }
  }

  // Mute escape hatch: the habitual top weight moved → forgive past ignores.
  const topRung = usualLadder.value?.rungs[usualLadder.value.rungs.length - 1]
  if (mine.ignoredCount >= NUDGE_COOLDOWNS.length && topRung &&
      Math.abs(topRung.weightLbs - (mine.shownForWeightLbs - NUDGE_WEIGHT_INCREMENT)) > LADDER_MATCH_TOLERANCE) {
    mine.ignoredCount = 0
    changed = true
  }

  if (changed) writeNudgeState(state)
}

/** Rounds a raw-lbs suggestion UP to the next achievable display increment (5 lbs / 2.5 kg). */
function roundUpDisplayWeight(lbs: number): number {
  if (weightUnit.value === 'kg') {
    return Math.ceil((lbs * 0.453592) / 2.5) * 2.5
  }
  return Math.ceil(lbs / 5) * 5
}

const overloadNudge = computed(() => {
  void nudgeStateVersion.value // re-evaluate after state writes
  // Gate 1: log mode for an existing exercise, today, both fields empty.
  if (!ladderActive.value || weightStr.value !== '' || repsStr.value !== '') return null
  // Gate 2: the habitual top set is the one up next.
  const rungs = usualLadder.value!.rungs
  if (nextRungIndex.value !== rungs.length - 1) return null
  // Gate 3: the data strongly supports going heavier (today's in-progress
  // session excluded — its partial top set would mask the signal).
  const id = selectedExerciseId.value
  const suggestion = store.getOverloadSuggestion(id, todayISO())
  if (!suggestion || suggestion.confidence !== 'high') return null
  const topRung = rungs[rungs.length - 1]
  // Gate 4 (deload guard): last session never reached the usual top — don't push.
  const prior = store.getLastSession(id, todayISO())
  if (!prior || prior.sets.length === 0) return null
  const priorTop = Math.max(...prior.sets.map(s => s.weight))
  if (priorTop < topRung.weightLbs - LADDER_MATCH_TOLERANCE) return null
  // Gate 5 (break guard): coming back from 3+ weeks off — ease back in.
  const today = todayISO()
  if (daysBetweenISO(prior.date, today) > NUDGE_BREAK_DAYS) return null
  // Gate 6: rate limits.
  const state = readNudgeState()
  const mine = state.byExercise[id]
  const shownTodayForMe = mine?.lastShownDay === today
  // One nudge per calendar day across ALL exercises (same-day re-show of
  // this exercise's own instance is allowed — consistency, not nagging).
  if (state.lastGlobalShownDay === today && !shownTodayForMe) return null
  if (shownTodayForMe && mine.outcome !== 'pending') return null
  if (mine && !shownTodayForMe) {
    const cooldown = NUDGE_COOLDOWNS[Math.min(mine.ignoredCount, NUDGE_COOLDOWNS.length - 1)]
    if (mine.ignoredCount >= NUDGE_COOLDOWNS.length) return null // muted
    if (daysBetweenISO(mine.lastShownDay, today) < cooldown) return null
  }

  return {
    weightLbs: suggestion.weight,
    displayWeight: roundUpDisplayWeight(suggestion.weight),
    reps: suggestion.reps,
    fromWeightLbs: topRung.weightLbs,
    fromReps: topRung.reps,
  }
})

// Record "shown" once per (exercise, calendar day); same-day modal reopens
// re-show the same instance without re-counting.
watch(overloadNudge, (n) => {
  if (!n) return
  const id = selectedExerciseId.value
  const today = todayISO()
  const state = readNudgeState()
  const mine = state.byExercise[id]
  if (mine?.lastShownDay === today) return
  state.byExercise[id] = {
    lastShownDay: today,
    shownForWeightLbs: n.weightLbs,
    outcome: 'pending',
    ignoredCount: mine?.ignoredCount ?? 0,
  }
  state.lastGlobalShownDay = today
  writeNudgeState(state)
  logEvent('overload_nudge_shown')
})

/** Tapping the card fills the fields — it never saves. The user can edit, then Save. */
function acceptOverloadNudge() {
  const n = overloadNudge.value
  if (!n) return
  if (plateMode.value) {
    // n.displayWeight is already display units — decompose it directly.
    const plates = platesForWeight(n.displayWeight)
    if (plates) {
      currentPlates.value = plates
      syncPlateWeight()
    }
  } else {
    weightStr.value = String(n.displayWeight)
  }
  repsStr.value = String(n.reps)
  impactLight()
}

/** Called from saveSet: a logged set at or above the suggested weight accepts the nudge. */
function recordNudgeAcceptIfAny(exerciseId: string, savedWeightLbs: number) {
  const state = readNudgeState()
  const mine = state.byExercise[exerciseId]
  if (!mine || mine.outcome !== 'pending' || mine.lastShownDay !== todayISO()) return
  if (savedWeightLbs >= mine.shownForWeightLbs - LADDER_MATCH_TOLERANCE) {
    mine.outcome = 'accepted'
    mine.ignoredCount = 0
    writeNudgeState(state)
    logEvent('overload_nudge_accepted')
  }
}

// ── Plate calculator state ──────────────────────────────────────
const currentPlates = ref<number[]>([])
const previousPlates = ref<number[]>([])

const plateMode = computed(() => {
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  return ex?.inputMode === 'plates'
})
const plateNumpadOverride = ref(false)

// ── Plate calculator hint (LIFT-388) ────────────────────────────
const PLATE_HINT_KEY = 'plate-calc-hint-dismissed'
const plateHintDismissed = ref(!!localStorage.getItem(PLATE_HINT_KEY))

const showPlateHint = computed(() =>
  !plateHintDismissed.value &&
  !plateMode.value &&
  !isEditMode.value &&
  isLogForExercise.value
)

function dismissPlateHint() {
  plateHintDismissed.value = true
  localStorage.setItem(PLATE_HINT_KEY, 'true')
}

function openSettingsFromHint() {
  dismissPlateHint()
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  if (ex) openEditExerciseModal(ex)
}

// ── Explore-path chart-discovery tip (LIFT-1086) ────────────────
// The "Explore first" onboarding path seeds a rich sample journey, but the
// only cue a new user sees frames the data as something to delete. Nudge them
// to open an exercise and view its progress chart — the demonstrative payoff.
// Gated on the sample-data flag so it never appears for real users, and shown
// once (dismissed on the first exercise open or via the × button).
const CHART_TIP_KEY = 'explore-chart-tip-dismissed'
const chartTipDismissed = ref(!!localStorage.getItem(CHART_TIP_KEY))
const hasSampleData = ref(localStorage.getItem('sample-data') === 'true')

const showChartTip = computed(() =>
  hasSampleData.value &&
  !chartTipDismissed.value &&
  listView.value === 'exercises' &&
  filteredExercises.value.length > 0
)

function dismissChartTip() {
  chartTipDismissed.value = true
  localStorage.setItem(CHART_TIP_KEY, 'true')
}

function adjustReps(delta: number) {
  const current = reps.value ?? 0
  const next = Math.max(0, Math.min(MAX_REPS, current + delta))
  if (next === 0) {
    repsStr.value = ''
  } else {
    repsStr.value = String(next)
  }
}

/** Clears the weight field from the logSetFieldClear × button (05-logset-platecalc.png). */
function clearWeight() {
  weightStr.value = ''
  weightInputEl.value?.focus()
}

/** True when the weight input has a non-empty numeric value — drives the gold
 *  border on the weight card and the visibility of the × clear button. */
const weightHasValue = computed(() => weightStr.value.trim().length > 0)

function loadPRTarget() {
  if (!prTargetWeight.value) return
  // prTargetWeight is display units, same space as the denoms and bar (LIFT-1211).
  const target = prTargetWeight.value
  const denoms = activeDenominations.value
  const barWt = currentBarWeight.value
  // Smallest weight increment: smallest plate × 2 for per-side, × 1 for total
  const smallestIncrement = denoms[denoms.length - 1] * (isPerSide.value ? 2 : 1)
  // Round up to nearest achievable weight above bar
  const plateWeight = target - barWt
  if (plateWeight <= 0) {
    currentPlates.value = []
    syncPlateWeight()
    return
  }
  const roundedPlateWeight = Math.ceil(plateWeight / smallestIncrement) * smallestIncrement
  const roundedTotal = barWt + roundedPlateWeight
  const plates = platesForWeight(roundedTotal)
  if (plates) {
    currentPlates.value = plates
    syncPlateWeight()
  }
}

function loadPRTargetReps() {
  if (!prTargetReps.value || prTargetReps.value < 1) return
  repsStr.value = String(prTargetReps.value)
}

/** `prTargetReps === 0` means any rep at this weight beats the baseline, so the
 *  card's payload is a single rep. Named rather than inlined because it is bound
 *  from three places (click + Enter + Space, LIFT-1305). */
function loadSinglePRTargetRep() {
  repsStr.value = '1'
}

/** `bodyweightBeatsPRTarget`'s payload: add nothing (LIFT-1330). */
function loadBodyweightOnlyTarget() {
  weightStr.value = '0'
}

const currentBarWeight = computed(() => {
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  if (ex?.barWeight !== undefined) return ex.barWeight
  // Default: standard bar for per-side (45 lbs / 20 kg), 0 for total (machine)
  return isPerSide.value ? defaultBarWeight(weightUnit.value) : 0
})

const isPerSide = computed(() => {
  const ex = store.exercises.find(e => e.id === selectedExerciseId.value)
  return (ex?.plateCountMode ?? 'per-side') === 'per-side'
})

/**
 * The bodyweight (lbs) the store will fold into this exercise's next set — the
 * offset between the two weight spaces this sheet straddles (#1328), and 0 for
 * every normal exercise.
 *
 * The weight field, the routine ladder, and the last-session chips are all ADDED
 * weight (`set.weight`). Everything derived from `estimated1RM` — the live
 * estimate, the PR badge, the to-beat card, the intensity anchor — is EFFECTIVE
 * load, because `logSet` folds bodyweight in before storing it (LIFT-834). A
 * suggestion inverted out of a PR therefore has to come back across this offset
 * before it reaches the field, or it folds a second time on save: a 160 lb
 * lifter with a +25 x 5 pull-up PR was shown ~186 as an ADDED weight, which
 * saves as a ~404 e1RM and wins the PR it was only meant to match.
 *
 * In edit mode the set's OWN captured bodyweight is the offset — `updateSet`
 * preserves it — so the estimate stays the one the save will store even after
 * the lifter's weight has drifted.
 */
const bodyweightFoldLbs = computed(() => {
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return 0
  return store.bodyweightFoldFor(id, editingSet.value?.setId)
})

/**
 * The exercise the sheet is logging for — including in edit mode, where
 * `selectedExerciseId` is the edited set's exercise.
 */
const selectedExercise = computed(() => store.exercises.find(e => e.id === selectedExerciseId.value))

/**
 * True when the weight field means ADDED weight, so 0 is a real value and the
 * copy should say so (LIFT-1330). Keyed on the exercise's flag rather than on
 * `bodyweightFoldLbs`, which is also 0 for a lifter who has never weighed in —
 * the field still means "added" for them, and Save must not silently depend on
 * a number entered in another tab.
 */
const isAddedWeightField = computed(() => allowsZeroWeight(selectedExercise.value))

/** Visible label on the weight card, and the stem of its accessible name. */
const weightFieldLabel = computed(() => (isAddedWeightField.value ? 'Added' : 'Weight'))

/**
 * Accessible name. Starts with the visible label so speech input can still
 * address the field by what it reads (WCAG 2.5.3), but says "weight" too —
 * "Added" alone, announced without the card around it, names nothing.
 */
const weightFieldAriaLabel = computed(() => (isAddedWeightField.value ? 'Added weight' : 'Weight'))

/**
 * "135" is a barbell's placeholder — on a pull-up it implies a load the lifter
 * is supposed to add, which is half of why added-0 looked forbidden. "0" names
 * the ordinary value instead. It stays a placeholder, not a default: an empty
 * field is still empty (Save disabled), and that gap is what keeps the
 * "what should I add?" to-beat card on screen.
 */
const weightFieldPlaceholder = computed(() => {
  if (ghostArmed.value && nextRung.value) return String(displayWeight(nextRung.value.weightLbs))
  return isAddedWeightField.value ? '0' : '135'
})

/**
 * The weight floor, in one place (LIFT-1330). LIFT-834 built bodyweight-loaded
 * exercises so "a pure-bodyweight rep at added = 0 still scores", and the store
 * scored it correctly from day one — but every gate in this sheet hand-rolled
 * `weight > 0`, so the single most common set the feature exists to record (a
 * plain pull-up) could never be entered. The lifter's choices were to skip it or
 * to log a fake 1 lb, which then poisons the ladder clustering, `bestWeightAtReps`
 * and the overload nudge with a rung nobody actually loaded.
 *
 * Empty stays distinct from an explicit 0: `weight` is null for an untouched
 * field, which is what keeps the "what should I add?" to-beat card alive.
 */
const weightIsLoggable = computed(() => isLoggableWeight(weight.value, selectedExercise.value))

/**
 * The load (lbs) a set typed into the fields right now would put on the lifter —
 * the ADDED weight plus the fold. Zero only when nothing is entered or a
 * bodyweight-loaded exercise has no bodyweight on record; the surfaces that need
 * a real load to say anything (the 1RM estimate, the reps-to-beat card) gate on
 * THIS rather than on the field, so an added-0 set is describable while a
 * genuinely zero load stays silent instead of dividing by it.
 */
const typedLoadLbs = computed(() =>
  weightIsLoggable.value ? toLbs(weight.value!) + bodyweightFoldLbs.value : 0,
)

const activeDenominations = computed(() =>
  weightUnit.value === 'kg' ? KG_PLATES : LBS_PLATES
)

/**
 * Decompose a DISPLAY-unit total into the stack the plate card should show.
 *
 * Every "load this weight into the plates" path goes through here so none of
 * them can forget an input: the display-unit denominations (LIFT-1211), the
 * exercise's bar, and — the one LIFT-1312 fixed — its loading mode. Before
 * this, five call sites passed the first two and none passed the third, so a
 * total-mode (machine) exercise decomposed every typed or tapped weight as
 * though half of it were needed and the card read 2× low against the field.
 */
function platesForWeight(displayTotal: number): PlateSet | null {
  return weightToPlates(displayTotal, currentBarWeight.value, activeDenominations.value, isPerSide.value)
}


const plateCounts = computed(() => {
  const counts = new Map<number, number>()
  for (const p of currentPlates.value) counts.set(p, (counts.get(p) || 0) + 1)
  return counts
})

// Total shown by the plate card, in the user's DISPLAY unit. The whole plate
// subsystem — denominations (KG_PLATES/LBS_PLATES), ex.barWeight, and this
// total — operates in display units: kg users stack kg plates on a kg bar.
// Canonical-lbs values cross the boundary only via displayWeight() on the way
// in (ladder rungs) and toLbs() at set-save time. LIFT-1211: this computed was
// named plateWeightLbs and fed through displayWeight(), which multiplied kg
// users' already-kg totals by 0.4536 — every plate-mode set they logged was
// silently corrupted.
const plateWeightDisplay = computed(() =>
  platesToWeight(currentPlates.value, currentBarWeight.value, isPerSide.value)
)

function syncPlateWeight() {
  _plateSync = true
  weight.value = plateWeightDisplay.value
  nextTick(() => { _plateSync = false })
}

// Reverse sync: when weight changes from input/chips, update plates to match
let _plateSync = false

function syncPlatesFromWeight() {
  if (_plateSync || !plateMode.value) return
  const w = weight.value
  if (w === null || w <= 0) {
    currentPlates.value = []
    return
  }
  // w is already in display units — the same space as the denominations and
  // bar weight. Converting it to lbs here (pre-LIFT-1211) decomposed an lbs
  // total against kg plates for kg users.
  currentPlates.value = platesForWeight(w) || []
}

function addPlate(denom: number) {
  const preview = [...currentPlates.value, denom]
  const previewWeight = platesToWeight(preview, currentBarWeight.value, isPerSide.value)
  if (previewWeight > MAX_WEIGHT) return
  currentPlates.value = preview.sort((a, b) => b - a)
  syncPlateWeight()
}

function removePlate(denom: number) {
  const idx = currentPlates.value.indexOf(denom)
  if (idx === -1) return
  const updated = [...currentPlates.value]
  updated.splice(idx, 1)
  currentPlates.value = updated
  syncPlateWeight()
}
const newExerciseName = ref('')
const newExerciseTags = ref<string[]>([])
const newExerciseTagInput = ref('')
const newExercisePlateMode = ref(false)
const newExercisePlateCountMode = ref<PlateCountMode>('per-side')
const newExerciseBarWeight = ref(defaultBarWeight(weightUnit.value))

// ── Exercise database suggestions ──────────────────────────────
//
// ARIA APG combobox-with-listbox (LIFT-1304). The popup used to be
// mouse/touch-only — every option was tabindex="-1" and reachable only through
// @mousedown/@touchstart — so a keyboard user watched suggestions appear and
// then had to retype the whole name (WCAG 2.1.1, Level A). Activation runs
// through `aria-activedescendant`, which keeps DOM focus (and the caret, and
// the iOS keyboard) in the text field while arrowing through options.
const EXERCISE_SUGGESTIONS_ID = 'wt-exercise-suggestions'
const suggestionOptionId = (i: number) => `${EXERCISE_SUGGESTIONS_ID}-opt-${i}`

const exerciseSuggestions = computed(() =>
  searchExerciseDatabase(
    newExerciseName.value,
    store.exercises.map(e => e.name),
  ),
)

// Escape — and picking an option — closes the popup without clearing the
// field. Stored as the query it was dismissed AT rather than a boolean so the
// next keystroke re-opens it for free: a boolean reset by a watcher would race
// `selectExerciseSuggestion`, which changes the name and dismisses in one tick.
const suggestionsDismissedFor = ref<string | null>(null)
const suggestionsOpen = computed(() =>
  exerciseSuggestions.value.length > 0 &&
  suggestionsDismissedFor.value !== newExerciseName.value,
)

/** Index of the active option; -1 = none, i.e. the typed value stands (APG). */
const activeSuggestionIndex = ref(-1)
const activeSuggestionId = computed(() =>
  suggestionsOpen.value && activeSuggestionIndex.value >= 0
    ? suggestionOptionId(activeSuggestionIndex.value)
    : undefined,
)
// A changed query means a changed list, so a held index would point at a
// different exercise — or past the end of a shorter one.
watch(exerciseSuggestions, () => { activeSuggestionIndex.value = -1 })

/**
 * Clears popup state that is keyed to a specific query. Without this a stale
 * `suggestionsDismissedFor` would silently suppress the list the next time the
 * user typed that exact name.
 */
function resetExerciseSuggestions() {
  suggestionsDismissedFor.value = null
  activeSuggestionIndex.value = -1
}

function onExerciseNameKeydown(e: KeyboardEvent) {
  const items = exerciseSuggestions.value
  if (e.key === 'Escape') {
    if (!suggestionsOpen.value) return
    // Swallow it: the log overlay carries `@keydown.escape="closeModal"`, so an
    // un-stopped keydown would close the whole sheet, not just the popup —
    // discarding the half-typed exercise the user was only trying to un-filter.
    e.preventDefault()
    e.stopPropagation()
    suggestionsDismissedFor.value = newExerciseName.value
    activeSuggestionIndex.value = -1
    return
  }
  if (items.length === 0) return
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!suggestionsOpen.value) {
      // Re-open a popup that Escape dismissed, landing on the nearest end.
      suggestionsDismissedFor.value = null
      activeSuggestionIndex.value = e.key === 'ArrowDown' ? 0 : items.length - 1
      return
    }
    if (activeSuggestionIndex.value < 0) {
      activeSuggestionIndex.value = e.key === 'ArrowDown' ? 0 : items.length - 1
    } else {
      const delta = e.key === 'ArrowDown' ? 1 : -1
      activeSuggestionIndex.value =
        (activeSuggestionIndex.value + delta + items.length) % items.length
    }
    return
  }
  // Home/End are deliberately NOT hijacked — in a combobox with an editable
  // text field they belong to the caret, not to the option list.
  if (e.key === 'Enter' && suggestionsOpen.value && activeSuggestionIndex.value >= 0) {
    e.preventDefault()
    selectExerciseSuggestion(items[activeSuggestionIndex.value])
  }
}

function selectExerciseSuggestion(entry: ExerciseEntry) {
  newExerciseName.value = entry.name
  newExerciseTags.value = [...entry.tags]
  if (entry.inputMode === 'plates') {
    newExercisePlateMode.value = true
    // Database bar weights are lbs figures, but the stepper edits display
    // units and rounds to whole numbers (LIFT-1211), so convert and round:
    // the 45 lb standard bar lands on 20 kg, matching defaultBarWeight().
    newExerciseBarWeight.value = entry.barWeight === undefined
      ? defaultBarWeight(weightUnit.value)
      : Math.round(displayWeight(entry.barWeight))
  }
  // Choosing an option closes the popup (APG). Dismissing AT the chosen name
  // means any further keystroke re-opens it.
  suggestionsDismissedFor.value = entry.name
  activeSuggestionIndex.value = -1
}
const newBarWeightEditing = ref(false)
const newBarWeightInputEl = ref<HTMLInputElement | null>(null)
// String-based raw inputs to avoid iOS keyboard dismissal on type="number"
// Vue writing back the parsed number to el.value causes iOS Safari to dismiss
// the keyboard after each keystroke. Using type="text" + inputmode avoids this.
const weightStr = ref('')
const repsStr = ref('')
const weight = computed<number | null>({
  get: () => { const n = parseFloat(weightStr.value); return isNaN(n) ? null : n },
  set: (v) => { weightStr.value = v === null ? '' : String(v) },
})
const reps = computed<number | null>({
  get: () => { const n = parseInt(repsStr.value); return isNaN(n) ? null : n },
  set: (v) => { repsStr.value = v === null ? '' : String(v) },
})
// Sync plate display when weight changes from input/chips (not from plate buttons).
// Debounced to avoid recalculating plate combinations on every keystroke (LIFT-634).
let _plateSyncTimer: ReturnType<typeof setTimeout> | null = null
watch(weightStr, () => {
  if (!plateMode.value || _plateSync) return
  if (_plateSyncTimer) clearTimeout(_plateSyncTimer)
  _plateSyncTimer = setTimeout(syncPlatesFromWeight, 250)
})

const date = ref(todayISO())
const selectedRPE = ref<number | null>(null)
/**
 * The RPE scale is 6–10 in half steps, rendered as five WHOLE points plus a
 * half-step modifier rather than nine value chips. Nine chips at the 44pt
 * floor need 428px and the log sheet gives 350, so the old single row put
 * 9 / 9.5 / 10 off-screen behind an overflow scroller with no visible edge.
 * Six chips fit outright; a half-point costs one extra tap and nothing hides.
 * The value set is unchanged, and still what `parseGuards` accepts (6–10,
 * whole or half).
 */
const RPE_POINTS = [6, 7, 8, 9, 10] as const
const RPE_MAX = 10
/** Whether the scale is disclosed. The PILL, not the scale, owns this. */
const rpeExpanded = ref(false)

/**
 * Base point and half flag are DERIVED from the single `selectedRPE` value
 * rather than held alongside it — two sources for one rating is how the
 * chips and the saved set drift apart.
 */
const rpeBase = computed(() => (selectedRPE.value === null ? null : Math.floor(selectedRPE.value)))
const rpeHalf = computed(() => selectedRPE.value !== null && selectedRPE.value % 1 !== 0)
const canHalfRPE = computed(() => rpeBase.value !== null && rpeBase.value < RPE_MAX)

function formatRPE(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

function setRPEPoint(v: number) {
  // Tapping the selected point clears the rating outright — the tap-to-clear
  // idiom the chips have always had, and now the only thing the chips clear
  // (collapsing is the pill's job).
  if (rpeBase.value === v) {
    selectedRPE.value = null
    return
  }
  // The half rides along as the base moves — it is a modifier on the current
  // rating, not a tenth value. Except at the top: 10.5 is not an RPE.
  selectedRPE.value = rpeHalf.value && v < RPE_MAX ? v + 0.5 : v
}

function toggleRPEHalf() {
  if (rpeBase.value === null || rpeBase.value >= RPE_MAX) return
  selectedRPE.value = rpeHalf.value ? rpeBase.value : rpeBase.value + 0.5
}
// "Went for one more rep and missed it" for the set being logged/edited (#1271).
// Off by default and cleared after every save — the annotation describes ONE
// set, so carrying it to the next one would silently over-report effort.
const attemptedNextRep = ref(false)

/**
 * The rep count this save will actually commit: what's typed, or the armed
 * ghost rung when both fields are empty. Drives the toggle's label so it names
 * the rep that was attempted ("Went for rep 9") rather than an abstract "+1".
 */
const effortLoggedReps = computed<number | null>(() => {
  if (reps.value !== null && reps.value > 0) return reps.value
  if (ghostArmed.value && nextRung.value) return nextRung.value.reps
  return null
})

const nextRepToggleLabel = computed(() =>
  effortLoggedReps.value !== null
    ? `Went for rep ${effortLoggedReps.value + 1}`
    : 'Went for one more',
)
// Remembers the last date the user manually set when logging, so the modal
// re-opens to that date rather than always resetting to today.
const lastLogDate = ref(todayISO())

// Trigger the native date picker from a real user-gesture click. Needed
// because desktop Chrome doesn't open the picker on input-body clicks —
// only on the built-in calendar icon — and our input is opacity:0. On iOS,
// tapping the input opens its picker natively, but showPicker() within
// the gesture is a harmless no-op if the native picker is already opening.
function tryShowDatePicker(e: MouseEvent) {
  const el = e.currentTarget as HTMLInputElement
  try { el.showPicker() } catch { /* unsupported or gesture-less; native tap handles it */ }
}



const dateDisplay = computed(() => {
  if (!date.value) return 'Today'
  const today = todayISO()
  if (date.value === today) return 'Today'
  const prev = new Date()
  prev.setDate(prev.getDate() - 1)
  const yest = localDateKey(prev)
  if (date.value === yest) return 'Yesterday'
  return new Date(date.value + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
})

const isEditMode = computed(() => editingSet.value !== null)

// True when logging a set for a known, pre-selected exercise
const isLogForExercise = computed(() =>
  !isEditMode.value &&
  selectedExerciseId.value !== '' &&
  selectedExerciseId.value !== '__new__'
)

const selectedExerciseName = computed(() =>
  store.exercises.find(e => e.id === selectedExerciseId.value)?.name ?? ''
)


const modalTitle = computed(() => {
  if (isEditMode.value) return 'Edit Set'
  if (selectedExerciseId.value === '__new__') return 'New Exercise'
  return selectedExerciseName.value || 'Log a Set'
})

// Open modal to log a brand-new exercise
function openNewExerciseModal() {
  editingSet.value = null
  selectedExerciseId.value = '__new__'
  newExerciseTags.value = []
  newExerciseSessionTags.value = []
  newExerciseTagInput.value = ''
  // Seed membership from the gym you're filtered to (#984). Creating an
  // exercise while filtered to a gym almost always means "I do this here",
  // and the alternative default is the silent failure this feature exists to
  // fix: unassigned shows under EVERY filter, so the new exercise would leak
  // to the other gym with nothing on screen suggesting it needs fixing. The
  // seeded chip renders selected, so it stays visible and one tap undoes it.
  newExerciseGyms.value = effectiveGymFilter.value ? [effectiveGymFilter.value] : []
  newExerciseGymInput.value = ''
  newGymAdding.value = false
  newExercisePlateMode.value = false
  newExercisePlateCountMode.value = 'per-side'
  newExerciseBarWeight.value = defaultBarWeight(weightUnit.value)
  date.value = lastLogDate.value
  showModal.value = true
}

const newTagInputEl = ref<HTMLInputElement | null>(null)
const newTagAdding = ref(false)

function startNewTagAdd() {
  newTagAdding.value = true
  nextTick(() => newTagInputEl.value?.focus())
}

function addNewExerciseTag() {
  const tag = newExerciseTagInput.value.trim()
  if (tag) {
    if (!newExerciseSessionTags.value.includes(tag)) newExerciseSessionTags.value.push(tag)
    if (!newExerciseTags.value.includes(tag)) newExerciseTags.value.push(tag)
  }
  newExerciseTagInput.value = ''
  nextTick(() => newTagInputEl.value?.focus())
}

function finishNewTagAdd() {
  const tag = newExerciseTagInput.value.trim()
  if (tag) {
    if (!newExerciseSessionTags.value.includes(tag)) newExerciseSessionTags.value.push(tag)
    if (!newExerciseTags.value.includes(tag)) newExerciseTags.value.push(tag)
  }
  newExerciseTagInput.value = ''
  newTagAdding.value = false
}


const newExerciseSessionTags = ref<string[]>([])

const allNewExerciseTags = computed(() => {
  const all = new Set([...store.allTags, ...newExerciseTags.value, ...newExerciseSessionTags.value])
  return [...all]
})

function toggleNewExerciseTag(tag: string) {
  if (newExerciseTags.value.includes(tag)) {
    newExerciseTags.value = newExerciseTags.value.filter(t => t !== tag)
  } else {
    newExerciseTags.value.push(tag)
  }
}

// ── Gym membership for a new exercise (#984) ────────────────────
// Mirrors EditExerciseModal's inline-add flow, minus the emit hop: this
// component already owns `gymActions`, so a typed gym is created in the
// preferences store immediately and `allGyms` picks it up reactively. That
// is why there is no "session gyms" list like `newExerciseSessionTags` —
// the gym list is authoritative the moment the name is committed.
const newExerciseGyms = ref<string[]>([])
const newExerciseGymInput = ref('')
const newGymInputEl = ref<HTMLInputElement | null>(null)
const newGymAdding = ref(false)

function startNewGymAdd() {
  newGymAdding.value = true
  nextTick(() => newGymInputEl.value?.focus())
}

/** Commit typed text as a gym: create it if new, then select it locally. */
function commitNewExerciseGym() {
  const name = sanitizeGymName(newExerciseGymInput.value)
  newExerciseGymInput.value = ''
  if (!name) return
  if (!allGyms.value.includes(name)) {
    if (allGyms.value.length >= MAX_GYMS) return
    if (!gymActions.createGym(name)) return
  }
  if (!newExerciseGyms.value.includes(name)) newExerciseGyms.value.push(name)
}

function addNewExerciseGym() {
  commitNewExerciseGym()
  nextTick(() => newGymInputEl.value?.focus())
}

function finishNewGymAdd() {
  commitNewExerciseGym()
  newGymAdding.value = false
}

function toggleNewExerciseGym(gym: string) {
  if (newExerciseGyms.value.includes(gym)) {
    newExerciseGyms.value = newExerciseGyms.value.filter(g => g !== gym)
  } else {
    newExerciseGyms.value.push(gym)
  }
}

const timelineLogPicking = ref(false)

function openTimelineLogModal() {
  timelineLogPicking.value = true
}

function pickExerciseForLog(exerciseId: string) {
  timelineLogPicking.value = false
  openLogForExercise(exerciseId)
}

/** "New exercise" row inside the picker — closes the picker and opens the
 *  new-exercise flow instead of an existing exercise. */
function pickNewExerciseFromPicker() {
  timelineLogPicking.value = false
  openNewExerciseModal()
}

// Open modal pre-targeted at a specific existing exercise
function openLogForExercise(exerciseId: string) {
  editingSet.value = null
  selectedExerciseId.value = exerciseId
  selectedRPE.value = null
  rpeExpanded.value = false
  attemptedNextRep.value = false
  lastSessionUsed.value = {}
  intensityUsed.value = {}
  intensityPct.value = INTENSITY_DEFAULT_PCT
  date.value = lastLogDate.value
  usualLadder.value = store.getUsualLadder(exerciseId, todayISO())
  // Default the Suggestions drawer to the first available lens, opened only
  // when that lens is a quick-fill (routine/last) so the one-tap ghost-arm flow
  // is immediate; intensity/PR-only states start collapsed (clean surface).
  const lenses = suggestionLenses.value
  activeLens.value = lenses[0] ?? 'routine'
  suggestionsExpanded.value = lenses[0] === 'routine' || lenses[0] === 'last'
  settleNudgeOutcome(exerciseId)
  // Initialize plate calculator: prefer the ladder's next rung, else last set
  const exercise = store.exercises.find(e => e.id === exerciseId)
  if (exercise?.inputMode === 'plates') {
    const lastSet = exercise.sets.length > 0 ? exercise.sets[exercise.sets.length - 1] : null
    const seedWeight = (ladderActive.value && nextRung.value) ? nextRung.value.weightLbs : lastSet?.weight ?? null
    if (seedWeight !== null) {
      // Seed in DISPLAY units against the same bar the plate card reads — this
      // is `syncPlatesFromWeight` applied to the seed, so the opening stack and
      // the weight field agree. It used to decompose the canonical-lbs seed
      // against a hardcoded 45 lb bar and kg denominations: the last surviving
      // instance of the LIFT-1211 mixing, and a third answer to "which bar?"
      // beside `currentBarWeight` (LIFT-1223). A kg user opening a 132 lb lift
      // got a stack for a bar 25 kg heavier than the one the total was computed
      // from — usually unloadable, so the card opened blank under a filled
      // weight field and then silently repopulated 250ms later when the
      // weightStr watcher recomputed it correctly. Routed through
      // `platesForWeight` so the seed carries the loading mode too (LIFT-1312).
      const seedDisplay = displayWeight(seedWeight)
      const plates = platesForWeight(seedDisplay)
      currentPlates.value = plates || []
      previousPlates.value = plates || []
      weight.value = seedDisplay
    } else {
      currentPlates.value = []
      previousPlates.value = []
    }
  } else {
    currentPlates.value = []
    previousPlates.value = []
  }
  showModal.value = true
}

// Open modal to edit an existing set
function openEditModal(exercise: Exercise, set: WorkoutSet) {
  editingSet.value = { exerciseId: exercise.id, setId: set.id }
  selectedExerciseId.value = exercise.id
  date.value = setDayKey(set.date)
  weight.value = displayWeight(set.weight)
  reps.value = set.reps
  selectedRPE.value = set.rpe ?? null
  rpeExpanded.value = false
  attemptedNextRep.value = set.attemptedNextRep === true
  showModal.value = true
}

function closeModal() {
  // Save the current date before resetting so subsequent log modals default to it.
  // Only do this in log mode — edit mode dates shouldn't affect the default.
  if (!isEditMode.value) {
    lastLogDate.value = date.value
  }
  showModal.value = false
  timerCtrl.editingPresets.value = false
  setLogAnnouncement.value = ''
  editingSet.value = null
  selectedExerciseId.value = ''
  newExerciseName.value = ''
  resetExerciseSuggestions()
  newExerciseTags.value = []
  newExerciseSessionTags.value = []
  newExerciseTagInput.value = ''
  newExerciseGyms.value = []
  newExerciseGymInput.value = ''
  newGymAdding.value = false
  weight.value = null
  reps.value = null
  selectedRPE.value = null
  rpeExpanded.value = false
  attemptedNextRep.value = false
  date.value = todayISO()
  plateNumpadOverride.value = false
  suggestionsExpanded.value = false
  activeLens.value = 'routine'
  usualLadder.value = null
  ghostJustSaved.value = false
  if (_ghostRearmTimer) { clearTimeout(_ghostRearmTimer); _ghostRearmTimer = null }
}

// ── Rest timer (state lives in timerCtrl composable) ────────────
// Keep screen awake while the rest timer is running or the log-set modal is open
const wakeLockNeeded = computed(() => timerCtrl.timerActive.value || showModal.value)
useWakeLock(wakeLockNeeded, wakeLockEnabled)

function skipToNextSet() {
  timerCtrl.stopTimer()
  date.value = lastLogDate.value
}

function onOverlayClick() {
  if (timerCtrl.editingPresets.value) {
    timerCtrl.editingPresets.value = false
  } else {
    closeModal()
  }
}

function dismissTimer() {
  timerCtrl.stopTimer()
  closeModal()
}

function openRestTimer() {
  showModal.value = true
  if (!timerCtrl.timerActive.value) {
    timerCtrl.startRestTimer()
  }
}


// The estimate this sheet shows must be the number `logSet` will store, so it
// runs the same `epley()` over the same folded load (#1328) rather than an
// inlined copy of the formula over the bare field value. On a bodyweight-loaded
// pull-up the two differed by the lifter's entire bodyweight: "+25 x 5" read as
// a ~29 lb estimated 1RM against a stored PR of ~216, so the badge below could
// never fire no matter how heavy the set.
const liveEstimateLbs = computed<number | null>(() => {
  if (!weightIsLoggable.value || !reps.value || reps.value < 1) return null
  // Gated on the folded load, not the field: an added-0 pull-up is a real set
  // (LIFT-1330) and estimates fine, while an added-0 set on an exercise with no
  // bodyweight on record carries no load at all and has nothing to estimate.
  if (typedLoadLbs.value <= 0) return null
  return epley(typedLoadLbs.value, reps.value)
})

const liveEstimate = computed(() =>
  liveEstimateLbs.value === null ? null : displayWeight(liveEstimateLbs.value),
)

const isNewPR = computed(() => {
  if (!liveEstimateLbs.value || isEditMode.value) return false
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return false
  const exercise = store.exercises.find(e => e.id === id)
  if (!exercise) return false
  if (!isExerciseEstablished(exercise.sets, date.value || todayISO())) return false
  const pr = store.getExercisePR(id, prBaselineDate.value)
  return pr > 0 && liveEstimateLbs.value > pr
})

// ── PR target suggestions (inverse Epley) ──────────────────────
// When only one field is filled, show what's needed in the other to beat the PR
//
// The PR is an EFFECTIVE load, so inverting it yields an effective weight; what
// the field wants is the ADDED weight, hence the un-fold (#1328). Null covers
// two distinct cases — nothing to beat, and bodyweight alone already beating it
// (`bodyweightBeatsPRTarget` below owns that one, since there is no positive
// weight to suggest).
const prTargetAddedLbs = computed<number | null>(() => {
  if (isEditMode.value || !reps.value || reps.value < 1) return null
  // Show PR suggestion when the weight axis is still open; show the live
  // estimate once it is filled. An explicit 0 on a bodyweight-loaded exercise
  // counts as filled (LIFT-1330) — the answer to "what should I add?" is the
  // number already in the field.
  if (weightIsLoggable.value) return null
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null
  const pr = store.getExercisePR(id, prBaselineDate.value)
  if (pr <= 0) return null
  // Account for Epley rounding: round(w * (1 + r/30)) > pr triggers at pr + 0.5
  const target = pr + 0.5
  const effectiveLbs = reps.value === 1 ? target : target / (1 + reps.value / 30)
  return effectiveLbs - bodyweightFoldLbs.value
})

const prTargetWeight = computed<number | null>(() => {
  const addedLbs = prTargetAddedLbs.value
  if (addedLbs === null || addedLbs <= 0) return null
  const rawLbs = Math.ceil(addedLbs)
  // Round up to nearest achievable weight increment (5 lbs or 2.5 kg)
  // Round in display-unit space to avoid fractional conversion errors
  if (weightUnit.value === 'kg') {
    const rawKg = rawLbs * 0.453592
    const roundedKg = Math.ceil(rawKg / 2.5) * 2.5
    return roundedKg
  }
  const targetLbs = Math.ceil(rawLbs / 5) * 5
  return targetLbs
})

// A bodyweight-loaded lifter whose own bodyweight at this rep count already
// beats their best needs no added weight — a real state, not an error, and the
// weight-axis twin of `prTargetReps === 0`. Informational rather than tappable:
// the target is "add nothing", and the weight field cannot hold that (a set
// needs a positive weight to save).
const bodyweightBeatsPRTarget = computed(
  () => bodyweightFoldLbs.value > 0 && prTargetAddedLbs.value !== null && prTargetAddedLbs.value <= 0,
)

// ── Live XP preview (shown when both weight and reps are filled) ──
// Debounced XP preview — the underlying calculation is expensive (1RM, rep PR,
// streak multiplier) and triggers on every keystroke in weight/reps inputs.
// We debounce by 150ms so the preview updates after the user pauses typing,
// keeping INP low during rapid input. (#632)
type XPPreviewResult = { xp: number; zone: string; best1RM: number | null; isRepPR: boolean; isNewWeight: boolean }
const liveXPPreview = ref<XPPreviewResult | null>(null)
let _xpPreviewTimer: ReturnType<typeof setTimeout> | undefined

function _computeXPPreview(): XPPreviewResult | null {
  if (!progressionStore.progressionEnabled || !progressionStore.showProgression) return null
  if (!liveEstimateLbs.value || isEditMode.value) return null
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null

  const exercise = store.exercises.find(e => e.id === id)
  if (!exercise) return null

  const estimated1RM = liveEstimateLbs.value
  const w = toLbs(weight.value!)
  const r = reps.value!

  const { best1RM, isRepPR, isNewWeight, ratio, baseXP } = scoreSet({
    priorSets: exercise.sets,
    estimated1RM,
    weightLbs: w,
    reps: r,
    dateKey: date.value || todayISO(),
    baseline: prBaselineDate.value,
  })
  const xp = applyStreakMultiplier(baseXP, progressionStore.streakHistory, new Date().toISOString())

  let zone: string
  if (best1RM === null || ratio === null) {
    zone = 'New Exercise'
  } else if (ratio > 1.0) {
    zone = `PR! (${XP_CONFIG.prMultiplier}x)`
  } else if (ratio === 1.0) {
    zone = `Tied PR (${XP_CONFIG.tieMultiplier}x)`
  } else if (ratio < XP_CONFIG.warmupThreshold) {
    zone = 'Warmup'
  } else {
    zone = `${Math.round(ratio * 100)}% of best`
  }

  return {
    xp,
    zone,
    best1RM: best1RM ? displayWeight(best1RM) : null,
    isRepPR,
    isNewWeight,
  }
}

watch(
  () => [weight.value, reps.value, selectedExerciseId.value, isEditMode.value,
         progressionStore.progressionEnabled, progressionStore.showProgression] as const,
  () => {
    clearTimeout(_xpPreviewTimer)
    // Fast-clear when inputs are obviously invalid (no flicker of stale data)
    if (!weightIsLoggable.value || !reps.value || reps.value < 1) {
      liveXPPreview.value = null
      return
    }
    _xpPreviewTimer = setTimeout(() => { liveXPPreview.value = _computeXPPreview() }, 150)
  },
)

const prTargetReps = computed<number | null>(() => {
  if (isEditMode.value || !weightIsLoggable.value) return null
  if (reps.value && reps.value >= 1) return null // both filled
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null
  const pr = store.getExercisePR(id, prBaselineDate.value)
  if (pr <= 0) return null
  // The PR is an effective load, so the typed ADDED weight has to be folded
  // before it can be compared against it (#1328). An added-0 set with no
  // bodyweight on record carries no load, and "how many reps at nothing beats
  // your PR" divides by zero — there is no answer to offer (LIFT-1330).
  const wLbs = typedLoadLbs.value
  if (wLbs <= 0) return null
  // Account for Epley rounding: round(w * (1 + r/30)) > pr triggers at pr + 0.5
  if (Math.round(wLbs) > pr) return 0 // any rep beats it (1RM at this weight already exceeds PR)
  const needed = Math.ceil(30 * ((pr + 0.5) / wLbs - 1))
  // Epley at reps=1 uses weight directly (1RM = weight), not the formula.
  // If the formula says 1 rep but weight doesn't beat PR, need at least 2 reps.
  if (needed <= 1 && Math.round(wLbs) <= pr) return 2
  return needed
})

// Lenses available in the Suggestions drawer, in display order. Routine and
// last-session are mutually exclusive (a detected routine supersedes the raw
// last session); the intensity lens appends whenever there's a 1RM to anchor to
// (the slider may land on an empty table at extreme positions — that's fine,
// it's transient). The former separate "PR" lens is now the 100% end of the
// intensity slider (ceiling rounding), so there's nothing extra to push (#770).
const suggestionLenses = computed<SuggestionLens[]>(() => {
  if (isEditMode.value || !isLogForExercise.value) return []
  const lenses: SuggestionLens[] = []
  if (ladderActive.value) lenses.push('routine')
  else if (lastSession.value) lenses.push('last')
  if (intensityOneRM.value !== null) lenses.push('intensity')
  return lenses
})

// The effectively-shown lens: the user's selection if still available, else the
// first available lens. Keeps the body coherent when data shifts (e.g. backdate
// drops the routine lens) without needing a watcher to reset activeLens.
const currentLens = computed<SuggestionLens | null>(() => {
  const lenses = suggestionLenses.value
  if (!lenses.length) return null
  return lenses.includes(activeLens.value) ? activeLens.value : lenses[0]
})

function lensLabel(lens: SuggestionLens): string {
  switch (lens) {
    case 'routine': return 'Routine'
    case 'last': return 'Last'
    case 'intensity': return 'Intensity'
  }
}

// Collapsed-header summary: the names of the available lenses (e.g.
// "Routine · Intensity") so the drawer advertises its contents at a glance.
const suggestionHeaderSub = computed(() => suggestionLenses.value.map(lensLabel).join(' · '))

// ── Personal bests from actual history ──────────────────────────
// Best reps at the entered weight (exact match in lbs). Added-0 matches the
// exercise's own pure-bodyweight sets, so "your best at 0 lbs: 12 reps" is the
// rep PR to chase on a plain pull-up (LIFT-1330).
const bestRepsAtWeight = computed<number | null>(() => {
  if (!weightIsLoggable.value) return null
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null
  const exercise = store.exercises.find(e => e.id === id)
  if (!exercise) return null
  const wLbs = Math.round(toLbs(weight.value!))
  let best = 0
  for (const s of exercise.sets) {
    if (Math.round(s.weight) === wLbs && s.reps > best) best = s.reps
  }
  return best > 0 ? best : null
})

// Heaviest weight at the entered rep count (exact match)
const bestWeightAtReps = computed<number | null>(() => {
  if (!reps.value || reps.value < 1) return null
  const id = selectedExerciseId.value
  if (!id || id === '__new__') return null
  const exercise = store.exercises.find(e => e.id === id)
  if (!exercise) return null
  let best = 0
  for (const s of exercise.sets) {
    if (s.reps === reps.value && s.weight > best) best = s.weight
  }
  return best > 0 ? best : null
})

const hasSetData = computed(() => weightIsLoggable.value && weight.value! <= MAX_WEIGHT && reps.value !== null && reps.value >= 1 && reps.value <= MAX_REPS)

const canSave = computed(() => {
  if (isEditMode.value) return hasSetData.value
  if (selectedExerciseId.value === '__new__') return newExerciseName.value.length > 0
  return selectedExerciseId.value !== '' && (hasSetData.value || ghostArmed.value)
})

function saveSet() {
  if (!canSave.value) return
  if (isEditMode.value && editingSet.value && weight.value !== null && reps.value !== null) {
    const editExId = editingSet.value.exerciseId
    const editSetId = editingSet.value.setId
    store.updateSet(editExId, editSetId, toLbs(weight.value), reps.value, date.value, selectedRPE.value, attemptedNextRep.value)
    logEvent('set_edit')
    // `bodyweightFoldLbs` carries the edited set's own captured bodyweight
    // (updateSet preserves it), so the announcement describes the load that
    // was actually stored rather than today's weigh-in.
    const editLoad = setLoadLabel(
      { weight: toLbs(weight.value), bodyweight: bodyweightFoldLbs.value },
      selectedExercise.value,
    )
    announceSet(`Set updated: ${editLoad} × ${reps.value} rep${reps.value === 1 ? '' : 's'}`)
    // Recalc XP for the edited set
    if (progressionStore.progressionEnabled) {
      const ex = store.exercises.find(e => e.id === editExId)
      const set = ex?.sets.find(s => s.id === editSetId)
      if (ex && set) {
        const otherSets = ex.sets.filter(s => s.id !== editSetId)
        const { isPR: editIsPR, isRepPR: editIsRepPR, zone: editZone, baseXP } = scoreSet({
          priorSets: otherSets,
          estimated1RM: set.estimated1RM,
          weightLbs: set.weight,
          reps: set.reps,
          dateKey: set.date,
          baseline: prBaselineDate.value,
        })
        const xp = applyStreakMultiplier(baseXP, progressionStore.streakHistory, set.date)
        progressionStore.recalcSetXP(editSetId, xp, { theme: currentTheme.value, epoch: progressionStore.epoch, zone: editZone, isPR: editIsPR, isRepPR: editIsRepPR })
      }
    }
    closeModal()
  } else {
    let exerciseId: string = selectedExerciseId.value
    const isNew = exerciseId === '__new__'
    if (isNew) {
      // Auto-add any pending tag text
      const pendingTag = newExerciseTagInput.value.trim()
      if (pendingTag && !newExerciseTags.value.includes(pendingTag)) {
        newExerciseTags.value.push(pendingTag)
      }
      // Auto-add any pending gym text, mirroring the tag flush above, so a
      // half-typed gym isn't silently dropped by tapping Save.
      commitNewExerciseGym()
      const newId = store.addExercise(newExerciseName.value, newExerciseTags.value, { gyms: newExerciseGyms.value })
      if (!newId) return
      exerciseId = newId
      selectedExerciseId.value = exerciseId
      if (newExercisePlateMode.value) {
        store.setExerciseInputMode(newId, 'plates')
        store.setExercisePlateCountMode(newId, newExercisePlateCountMode.value)
        const ex = store.exercises.find(e => e.id === newId)
        if (ex) ex.barWeight = newExerciseBarWeight.value
      }
      newExerciseName.value = ''
      resetExerciseSuggestions()
      newExerciseTags.value = []
      newExerciseSessionTags.value = []
      newExerciseTagInput.value = ''
      newExerciseGyms.value = []
      newExerciseGymInput.value = ''
      newGymAdding.value = false
      newExercisePlateMode.value = false
      newExercisePlateCountMode.value = 'per-side'
      newExerciseBarWeight.value = defaultBarWeight(weightUnit.value)
      logEvent('exercise_add')
    }
    const typedSet = hasSetData.value && weight.value !== null && reps.value !== null
    if (typedSet || ghostArmed.value) {
      // Ghost save: commit the next rung's canonical stored lbs directly — no
      // toLbs round-trip drift for kg users, so the set reinforces its cluster.
      const effWeightLbs = typedSet ? toLbs(weight.value!) : nextRung.value!.weightLbs
      const effReps = typedSet ? reps.value! : nextRung.value!.reps
      // A ghost save replays a habitual set — it can never be a PR.
      const wasPR = typedSet ? isNewPR.value : false
      if (!typedSet) {
        // Disarm briefly so an accidental double-tap can't log two rungs.
        ghostJustSaved.value = true
        if (_ghostRearmTimer) clearTimeout(_ghostRearmTimer)
        _ghostRearmTimer = setTimeout(() => { ghostJustSaved.value = false }, GHOST_REARM_MS)
      }
      // Capture the pre-log baseline PR so the burst can show old → new e1RM.
      const oldE1RM = store.getExercisePR(exerciseId, prBaselineDate.value)
      // Snapshot PR count before logging so we can detect the user's very first PR.
      const prCountBefore = wasPR ? progressionStore.totalPRCount : 0
      // Detect a brand-new user's very first ever set (#762): no sets logged yet
      // anywhere, and the one-time flag hasn't fired. A first set can never be a
      // PR (PRs need a prior established session), so this won't collide with the
      // PR burst below.
      const isFirstSetEver =
        !wasPR &&
        localStorage.getItem(FIRST_SET_FLAG) !== 'true' &&
        store.exercises.every(e => e.sets.length === 0)
      store.logSet(exerciseId, effWeightLbs, effReps, date.value, {
        rpe: selectedRPE.value ?? undefined,
        attemptedNextRep: attemptedNextRep.value,
      })
      recordNudgeAcceptIfAny(exerciseId, effWeightLbs)
      logEvent('set_log', { exercise: selectedExerciseName.value, isPR: wasPR })
      const loggedLoad = setLoadLabel(
        { weight: effWeightLbs, bodyweight: bodyweightFoldLbs.value },
        selectedExercise.value,
      )
      announceSet(`Logged ${selectedExerciseName.value}: ${loggedLoad} × ${effReps} rep${effReps === 1 ? '' : 's'}${wasPR ? ', new personal record' : ''}`)
      // XP: get the just-logged set (last in array) and compute XP
      const exercise = store.exercises.find(e => e.id === exerciseId)
      if (exercise && exercise.sets.length > 0) {
        const newSet = exercise.sets[exercise.sets.length - 1]
        computeAndLogXP(exerciseId, newSet.id, newSet.estimated1RM, newSet.weight, newSet.reps)
      }
      // Haptic feedback — stronger for PRs
      if (wasPR) {
        notifySuccess()
        // Full-bleed PR celebration (respects the PR baseline via oldE1RM,
        // and the prCelebrations opt-out inside presentPRBurst).
        const newE1RM = store.getExercisePR(exerciseId, prBaselineDate.value)
        // Build the session summary here (WorkoutTracker owns store access) and
        // hand it to the burst so the presentational PRBurst component can drive
        // its "Share this PR" flow without reaching into stores (LIFT-916). The
        // set is already persisted and its XP logged above, so this reflects it.
        const prRawDate = date.value || todayISO()
        presentPRBurst({
          exerciseName: selectedExerciseName.value,
          oldE1RM,
          newE1RM,
          setWeight: effWeightLbs,
          setReps: effReps,
          isFirstPR: prCountBefore === 0,
          shareSummary: buildSessionSummary({
            rawDate: prRawDate,
            exercises: store.exercises,
            xpPerSet: progressionStore.xpPerSet,
            streakWeeks: progressionStore.streakWeeks,
            toDisplayUnits: displayWeight,
            unitLabel: weightUnit.value,
          }),
        })
        if (prCountBefore === 0) {
          logEvent('first_pr', { exercise: selectedExerciseName.value })
        }
      } else if (isFirstSetEver) {
        // Activation moment — celebrate the first set (fires its own haptic).
        localStorage.setItem(FIRST_SET_FLAG, 'true')
        logEvent('first_set', { exercise: selectedExerciseName.value })
        presentFirstSetCelebration()
      }
      // Celebrate the first weekly-goal completion of the week (LIFT-764). When
      // it fires its own success/milestone haptic, suppress the routine light
      // tap: two native haptics fired back-to-back collapse into a muddy /
      // truncated buzz on Capacitor/iOS. The light tap stays for the common
      // non-PR, no-celebration path. (PRs already played notifySuccess above and
      // skip the goal banner, so they never reach the light tap.) The first-set
      // activation overlay likewise fires its own haptic and suppresses the goal
      // banner (passed in below) so the two full-screen moments never stack — the
      // week is left unmarked, so the goal celebration still fires on the next set.
      const celebrated = maybeCelebrateWeeklyGoal(wasPR || isFirstSetEver)
      if (!wasPR && !isFirstSetEver && !celebrated) {
        impactLight()
      }
      if (restTimerEnabled.value && restTimerAutoStart.value) {
        timerCtrl.startRestTimer()
      }
      // Clear fields and stay on the modal for the next set
      plateNumpadOverride.value = false
      selectedRPE.value = null
      attemptedNextRep.value = false
      if (plateMode.value) {
        // Keep plate config for next set (user adjusts, not reloads)
        previousPlates.value = [...currentPlates.value]
        reps.value = null
      } else {
        weight.value = null
        reps.value = null
      }
      nextTick(() => weightInputEl.value?.focus())
    } else {
      closeModal()
    }
  }
}

// ── Undo-able destructive actions ────────────────────────────────
function undoDeleteSet(exerciseId: string, set: WorkoutSet) {
  store.deleteSet(exerciseId, set.id, { sync: false })
  logEvent('set_delete')
  showUndo(
    'Set deleted',
    () => store.restoreSet(exerciseId, set),
    () => {
      store.syncDeleteSet(set.id)
      progressionStore.removeSetXP(set.id)
    },
  )
}

function undoDeleteExercise(exercise: Exercise) {
  const saved = { ...exercise, sets: [...exercise.sets] }
  const idx = store.exercises.indexOf(exercise)
  if (detailExerciseId.value === exercise.id) detailExerciseId.value = null
  store.deleteExercise(exercise.id, { sync: false })
  logEvent('exercise_delete')
  showUndo(
    `"${saved.name}" deleted`,
    () => store.restoreExercise(saved, idx),
    () => {
      store.syncDeleteExercise(saved)
      saved.sets.forEach(s => progressionStore.removeSetXP(s.id))
    },
  )
}

// ── Archive ────────────────────────────────────────────────────
const archivedOpen = ref(false)
const archivedListId = 'wt-archived-list'

function handleArchiveFromEdit() {
  const id = editTarget.value
  if (!id) return
  const ex = store.exercises.find(e => e.id === id)
  if (!ex) return
  const name = ex.name
  if (detailExerciseId.value === id) detailExerciseId.value = null
  store.archiveExercise(id)
  editTarget.value = null
  logEvent('exercise_archive')
  showUndo(
    `"${name}" archived`,
    () => store.unarchiveExercise(id),
    () => { /* commit: archive already applied — no-op */ },
  )
}

function handleUnarchiveFromEdit() {
  const id = editTarget.value
  if (!id) return
  store.unarchiveExercise(id)
  editTarget.value = null
  archivedOpen.value = false
  logEvent('exercise_unarchive')
}

function unarchiveExerciseFromList(exerciseId: string) {
  store.unarchiveExercise(exerciseId)
  logEvent('exercise_unarchive')
}

// ── Edit exercise modal (extracted to EditExerciseModal.vue) ─────
// The parent owns which exercise is being edited and applies the saved
// form to the store; the modal owns the transient form state.
const editTarget = ref<string | null>(null)

const editTargetExercise = computed<Exercise | null>(() =>
  store.exercises.find(e => e.id === editTarget.value) ?? null
)

function openEditExerciseModal(exercise: Exercise) {
  editTarget.value = exercise.id
}

function onEditExerciseSave(payload: EditExerciseSave) {
  if (!editTarget.value) return
  store.renameExercise(editTarget.value, payload.name)
  store.updateExerciseTags(editTarget.value, payload.tags)
  // Save input mode and plate settings
  store.setExerciseInputMode(editTarget.value, payload.plateMode ? 'plates' : 'numpad')
  if (payload.plateMode) {
    store.setExercisePlateCountMode(editTarget.value, payload.plateCountMode)
    store.setExerciseBarWeight(editTarget.value, payload.barWeight)
  }
  store.setExerciseIntensityMaxReps(editTarget.value, payload.intensityMaxReps)
  store.setExerciseEquipment(editTarget.value, payload.equipment)
  store.setExerciseGyms(editTarget.value, payload.gyms)
  store.setExerciseNotes(editTarget.value, payload.notes)
  store.setExerciseBodyweightLoaded(editTarget.value, payload.bodyweightLoaded)
  editTarget.value = null
  // When switching to plate mode, reverse-sync the current weight into
  // plates so the user's entered value is preserved (LIFT-388 review fix).
  if (payload.plateMode && weight.value) {
    syncPlatesFromWeight()
  } else {
    syncPlateWeight()
  }
  logEvent('exercise_edit')
}

function onEditExerciseDelete() {
  const exercise = editTargetExercise.value
  if (!exercise) return
  undoDeleteExercise(exercise)
  editTarget.value = null
}

// ── Tag manager (extracted to TagManagerModal.vue) ─────────────
const tagManagerOpen = ref(false)

function openTagManager() {
  tagManagerOpen.value = true
}

function onRenameTag(oldName: string, newName: string) {
  store.renameTag(oldName, newName)
  logEvent('tag_rename')
}

function confirmDeleteTag(tag: string) {
  // Track which exercises have this tag for undo
  const affectedIds = store.exercises
    .filter(e => (e.tags || []).includes(tag))
    .map(e => e.id)
  const count = affectedIds.length
  store.deleteTag(tag)
  logEvent('tag_delete')
  showUndo(
    `Tag "${tag}" removed from ${count} exercise${count !== 1 ? 's' : ''}`,
    () => {
      // Undo: re-add tag to affected exercises
      affectedIds.forEach(id => {
        const exercise = store.exercises.find(e => e.id === id)
        if (exercise && !exercise.tags.includes(tag)) {
          store.updateExerciseTags(id, [...exercise.tags, tag])
        }
      })
    },
    () => {}
  )
}

// ── Gym manager (#961) ──────────────────────────────────────────
const gymManagerOpen = ref(false)
const gymActions = useGymActions()

function onRenameGym(oldName: string, newName: string) {
  const stored = gymActions.renameGym(oldName, newName)
  // Keep the active filter following its gym across a rename — without this
  // the stale-selection watch would reset it to All Gyms. (Renames from the
  // Settings-hosted manager intentionally take that reset path instead.)
  if (stored && activeGymFilter.value === oldName) {
    activeGymFilter.value = stored
  }
  logEvent('gym_rename')
}


// ── Modal lifecycle: useModal owns the lock + focus trap ────────
//
// Two instances, each contributing at most 1 to useModal's shared
// reference count:
//
//   • logModal       — the log-set sheet: background-scroll lock, focus trap
//                      (`.repMaxModal`), and the swipe-to-dismiss gesture.
//   • childModalLock — the four prop-driven child modals (detail / edit /
//                      tag manager / gym manager). They run their own focus
//                      traps internally but hold no lock of their own, so
//                      this instance takes one on their behalf.
//
// This replaced a hand-rolled `classList.toggle('modal-open', open)` watch.
// A boolean toggle is wrong the moment ANY other surface can hold the lock:
// closing a WorkoutTracker modal while, say, CalendarView's set editor was
// open stripped `modal-open` out from under it, re-enabling background
// scroll beneath a `position: fixed` modal. That is not cosmetic — once the
// iOS keyboard opens, the visual viewport shifts but the still-scrollable
// layout viewport does not, so paint desyncs from hit-testing and taps land
// a row low (#830). Only the reference count in useModal knows when the
// LAST holder has released.
//
// The focus trap deliberately does NOT pass `focusContainer` — that matches
// the behaviour this replaced (`logModalFocus.activate(el)` with no options),
// where the sheet's first focusable is the header history button, or the
// name field in new-exercise mode.
const logModal = useModal({
  selector: '.repMaxModal',
  onOpen: () => {
    // Attach swipe-to-dismiss gesture to the log-set sheet (step 5f).
    // The handle gets touch events so the gesture doesn't compete with
    // native scroll inside the sheet body.
    if (logSheetEl.value && logSheetHandleEl.value) {
      logSwipe.attach(logSheetEl.value, logSheetHandleEl.value)
    }
  },
  onClose: () => { logSwipe.detach() },
})
watch(showModal, (open) => {
  if (open) logModal.open()
  else logModal.close()
})

const childModalLock = useModal()
watch(
  () => !!detailExerciseId.value || editTarget.value !== null || tagManagerOpen.value || gymManagerOpen.value,
  (open) => {
    if (open) childModalLock.open()
    else childModalLock.close()
  },
)

onUnmounted(() => {
  timerCtrl.stopTimer()
  clearTimeout(_xpPreviewTimer)
  if (_plateSyncTimer) clearTimeout(_plateSyncTimer)
  // The scroll lock is released by useModal's own onUnmounted safety net.
})

// openNewExerciseModal is exposed so App.vue's top-bar "+" can open the
// new-exercise modal directly (the primary "add exercise" entry point).
// openTimelineLogModal is exposed for the timeline view's "Log a set" button
// and for unit tests; it opens the exercise picker used to quick-log a set.
defineExpose({ openTimelineLogModal, openNewExerciseModal, timerCtrl })
</script>

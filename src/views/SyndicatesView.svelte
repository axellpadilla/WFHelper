<script lang="ts">
  import { CREDITS_ICON_URL } from "../lib/assetUrls.js";
  import { formatNumber } from "../lib/format.js";
  import { locale, tr, type MessageKey } from "../lib/i18n.js";
  import { send } from "../lib/ipc.js";
  import { buildWikiUrl } from "../lib/wikiUrl.js";
  import { buildParsedItemFromDb } from "../lib/parsedItemFromDb.js";
  import {
    aggregateNeeds,
    alignmentConflicts,
    filterMissingRequirements,
    planSteps,
    syndicateStatus,
    type RankUpStep,
    type SyndicateGoalPlan,
    type SyndicateStatus,
  } from "../lib/syndicates/rankup.js";
  import { SYNDICATE_RANKS } from "../data/syndicateRanks.js";
  import { componentOwnership, inventoryData, itemDb } from "../stores/data.js";
  import { activeItem } from "../stores/modals.js";
  import {
    clearSyndicateGoals,
    setSyndicateGoal,
    syndicateGoals,
  } from "../stores/syndicateGoals.js";
  import ItemImage from "../components/ItemImage.svelte";
  import ItemTile from "../components/ItemTile.svelte";
  import ThemedButton from "../components/ThemedButton.svelte";
  import ThemedPanel from "../components/ThemedPanel.svelte";
  import WikiButton from "../components/WikiButton.svelte";
  import type { SyndicateKind, SyndicateMeta } from "../../config/shared/syndicateTypes.js";

  const GROUPS: { kind: SyndicateKind; labelKey: MessageKey }[] = [
    { kind: "normal", labelKey: "syndicates.groupNormal" },
    { kind: "openWorld", labelKey: "syndicates.groupOpenWorld" },
    { kind: "other", labelKey: "syndicates.groupOther" },
  ];

  interface SyndicateCard {
    meta: SyndicateMeta;
    status: SyndicateStatus;
    percent: number;
    targets: number[];
    goal: number | null;
    steps: RankUpStep[];
  }

  const NAME_BY_TAG = new Map(SYNDICATE_RANKS.map((meta) => [meta.tag, meta.name]));

  const inv = $derived($inventoryData);
  const db = $derived($itemDb);
  // One ownership source for rows, totals and the item modal.
  const owned = $derived($componentOwnership);

  const cards = $derived(
    SYNDICATE_RANKS.map((meta): SyndicateCard => {
      const status = syndicateStatus(inv, meta);
      const span = status.tierEnd - status.tierStart;
      const goal = $syndicateGoals[meta.tag] ?? null;
      const reachable = goal !== null && goal > status.level ? goal : null;
      const top = meta.titles.reduce((max, title) => Math.max(max, title.level), 0);
      const targets: number[] = [];
      for (let level = Math.max(1, status.level + 1); level <= top; level++) targets.push(level);
      return {
        meta,
        status,
        percent:
          span > 0
            ? Math.min(100, Math.max(0, ((status.standing - status.tierStart) / span) * 100))
            : 100,
        targets,
        goal: reachable,
        steps: reachable === null ? [] : planSteps(inv, meta, reachable),
      };
    }),
  );

  const plans = $derived(
    cards
      .filter((card) => card.goal !== null && card.steps.length > 0)
      .map(
        (card): SyndicateGoalPlan => ({
          meta: card.meta,
          targetLevel: card.goal ?? card.status.level,
          steps: card.steps,
        }),
      ),
  );

  const totals = $derived(aggregateNeeds(plans, inv, owned));
  let missingOnly = $state(false);
  const totalItems = $derived(missingOnly ? filterMissingRequirements(totals.items) : totals.items);
  const conflicts = $derived(alignmentConflicts(plans.map((plan) => plan.meta)));
  const hasGoals = $derived(Object.keys($syndicateGoals).length > 0);

  function missingStepItems(items: RankUpStep["items"]): RankUpStep["items"] {
    return filterMissingRequirements(
      items.map((item) => ({
        item,
        needed: item.count,
        owned: owned.get(item.itemType) ?? 0,
      })),
    ).map(({ item }) => item);
  }

  function openItem(itemType: string): void {
    const entry = db[itemType];
    if (!entry) return;
    activeItem.set(buildParsedItemFromDb(itemType, entry, owned));
  }

  function toggleGoal(tag: string, level: number, currentGoal: number | null): void {
    setSyndicateGoal(tag, currentGoal === level ? null : level);
  }

  /** Sacrifice items the item database does not carry (fish parts, dog tags)
   *  still deserve a lookup, so their row links straight to the wiki. */
  function openWiki(name: string): void {
    send("open-external", buildWikiUrl(name));
  }
</script>

<section class="view active" data-syndicates-view>
  <div class="view-header">
    <h2>{$tr("common.syndicates")}</h2>
    <span class="text-xs text-text-muted">{$tr("syndicates.hint")}</span>
    <div class="ml-auto flex items-center gap-2">
      <button
        type="button"
        class="cursor-pointer whitespace-nowrap rounded-[var(--radius-md)] border px-2 py-1 text-xs transition-[color,border-color,background] duration-150 hover:border-accent hover:text-accent {missingOnly
          ? 'border-accent bg-[color-mix(in_srgb,var(--accent)_18%,transparent)] font-semibold text-accent'
          : 'border-[color:var(--ui-control-border)] bg-bg-surface text-text-secondary'}"
        aria-pressed={missingOnly}
        data-syndicates-missing-only
        onclick={() => (missingOnly = !missingOnly)}
      >
        {$tr("syndicates.missingOnly")}
      </button>
      <ThemedButton disabled={!hasGoals} onClick={clearSyndicateGoals}>
        {$tr("syndicates.clearGoals")}
      </ThemedButton>
    </div>
  </div>

  {#if !inv}
    <div class="empty-state" data-syndicates-empty>
      <p>{$tr("syndicates.noData")}</p>
    </div>
  {:else}
    <!-- No overflow here: an own scrollport would capture the sticky totals
         panel, which has to stick against #content instead. -->
    <div class="grid grid-cols-1 gap-3 p-1 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="flex flex-col gap-4">
        {#each GROUPS as group (group.kind)}
          {@const rows = cards.filter((card) => card.meta.kind === group.kind)}
          {#if rows.length > 0}
            <div class="flex flex-col gap-2">
              <h3 class="m-0 text-xs font-semibold uppercase tracking-wide text-text-muted">
                {$tr(group.labelKey)}
              </h3>
              {#each rows as card (card.meta.tag)}
                <article data-syndicate-card={card.meta.tag}>
                  <ThemedPanel className="flex flex-col gap-2 p-3">
                    <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span class="text-sm font-semibold text-text-primary">{card.meta.name}</span>
                      <span class="text-xs text-text-muted">
                        {#if card.status.title}
                          {$tr("browse.rankValue", { value: String(card.status.level) })} ·
                          {card.status.title}
                        {:else}
                          {$tr("syndicates.unranked")}
                        {/if}
                      </span>
                      <div class="ml-auto flex items-center gap-2">
                        {#if card.status.dailyRemaining !== null}
                          <span class="text-xs text-text-muted" data-syndicate-daily>
                            {card.status.dailyRemaining > 0
                              ? $tr("dailies.standingLeft", {
                                  amount: formatNumber(card.status.dailyRemaining, $locale),
                                })
                              : $tr("syndicates.dailyCapped")}
                          </span>
                        {/if}
                        <WikiButton wikiUrl={null} fallbackName={card.meta.wikiPage} />
                      </div>
                    </div>

                    <div class="flex items-center gap-2">
                      <div class="standing-track h-1.5 flex-1 rounded-full">
                        <div
                          class="standing-fill h-full rounded-full"
                          style="width:{card.percent}%"
                        ></div>
                      </div>
                      <span class="whitespace-nowrap text-xs text-text-muted">
                        {#if card.status.nextLevel === null}
                          {$tr("syndicates.maxRank")}
                        {:else}
                          {$tr("syndicates.toNextRank", {
                            amount: formatNumber(card.status.standingToNext, $locale),
                            level: String(card.status.nextLevel),
                          })}
                        {/if}
                      </span>
                    </div>

                    {#if card.targets.length > 0}
                      <div class="flex flex-wrap items-center gap-1.5">
                        <span class="text-xs text-text-muted">{$tr("syndicates.target")}</span>
                        {#each card.targets as level (level)}
                          <ThemedButton
                            size="compact"
                            active={card.goal === level}
                            onClick={() => toggleGoal(card.meta.tag, level, card.goal)}
                          >
                            <span data-syndicate-goal={level}>{level}</span>
                          </ThemedButton>
                        {/each}
                      </div>
                    {/if}

                    {#each card.steps as step (step.level)}
                      <div
                        class="flex flex-col gap-1 border-t border-[color:var(--ui-panel-border)] pt-2"
                        data-syndicate-step={step.level}
                      >
                        <div class="flex flex-wrap items-baseline gap-x-2 text-xs">
                          <!-- Only rank 0 is untitled, and it is a real step: leaving
                               rank -1 is what it pays for. DE calls that rank Neutral.
                               Keyed on the level, since a titles gap also empties title. -->
                          <span class="font-semibold text-text-secondary">
                            {$tr("syndicates.stepTitle", {
                              level: String(step.level),
                              title: step.level === 0 ? $tr("syndicates.neutralRank") : step.title,
                            })}
                          </span>
                          <span class="text-text-muted">
                            {$tr("dailies.standing", {
                              amount: formatNumber(step.standingNeeded, $locale),
                            })}
                          </span>
                          {#if step.initiation}
                            <span class="text-warning">
                              {$tr("syndicates.initiationIncluded")}
                            </span>
                          {/if}
                        </div>

                        <div class="flex flex-wrap items-start gap-x-2 gap-y-2">
                          {#if step.credits > 0}
                            {@const creditsMissing =
                              filterMissingRequirements([
                                { needed: step.credits, owned: totals.credits.owned },
                              ]).length > 0}
                            {#if !missingOnly || creditsMissing}
                              <ItemTile
                                tileKey="credits"
                                imageUrl={CREDITS_ICON_URL}
                                label={$tr("common.credits")}
                                count={formatNumber(step.credits, $locale)}
                                enough={totals.credits.owned >= step.credits}
                              />
                            {/if}
                          {/if}
                          {#each missingOnly ? missingStepItems(step.items) : step.items as item (item.itemType)}
                            {@const have = owned.get(item.itemType) ?? 0}
                            {@const label = db[item.itemType]?.displayName ?? item.name}
                            <ItemTile
                              tileKey={item.itemType}
                              imageUrl={db[item.itemType]?.imageUrl ?? null}
                              {label}
                              auditKey={item.name}
                              count={$tr("syndicates.ownedOfNeeded", {
                                owned: formatNumber(have, $locale),
                                needed: formatNumber(item.count, $locale),
                              })}
                              enough={have >= item.count}
                              missingKey={have < item.count ? item.itemType : null}
                              onOpen={db[item.itemType]
                                ? () => openItem(item.itemType)
                                : () => openWiki(item.name)}
                            />
                          {/each}
                        </div>
                      </div>
                    {/each}
                  </ThemedPanel>
                </article>
              {/each}
            </div>
          {/if}
        {/each}
      </div>

      <!-- The 0.5rem is the sticky top (top-1) plus the wrapper's own bottom
           padding (p-1), so the panel stops exactly at the grid's edge. -->
      <aside
        class="self-start xl:sticky xl:top-1 xl:max-h-[calc(100vh_-_var(--titlebar-height)_-_var(--statusbar-height)_-_0.5rem)] xl:overflow-y-auto"
        data-syndicates-totals
      >
        <ThemedPanel className="flex flex-col gap-3 p-3">
          <h3 class="m-0 text-sm font-semibold text-text-primary">
            {$tr("syndicates.totalsTitle")}
          </h3>

          {#if plans.length === 0}
            <p class="m-0 text-xs text-text-muted">{$tr("syndicates.noGoals")}</p>
          {:else}
            {#each conflicts as conflict (conflict.a + conflict.b)}
              <p class="m-0 text-xs text-warning" data-syndicate-conflict>
                {$tr("syndicates.alignmentWarning", {
                  a: NAME_BY_TAG.get(conflict.a) ?? conflict.a,
                  b: NAME_BY_TAG.get(conflict.b) ?? conflict.b,
                })}
              </p>
            {/each}

            {#if !missingOnly || totals.credits.missing > 0}
              <div class="flex items-center gap-2 text-xs">
                <img
                  class="h-4 w-4 object-contain"
                  src={CREDITS_ICON_URL}
                  alt={$tr("common.credits")}
                />
                <span class="text-text-secondary"
                  >{formatNumber(totals.credits.needed, $locale)}</span
                >
                {#if totals.credits.missing > 0}
                  <span class="text-danger">
                    {$tr("syndicates.missingAmount", {
                      amount: formatNumber(totals.credits.missing, $locale),
                    })}
                  </span>
                {/if}
              </div>
            {/if}

            {#if totalItems.length > 0}
              <ul class="m-0 flex list-none flex-col gap-1 p-0">
                {#each totalItems as item (item.itemType)}
                  {@const label = db[item.itemType]?.displayName ?? item.name}
                  <li class="flex items-center gap-2 text-xs" data-syndicate-total-item>
                    <span class="h-4 w-4 shrink-0">
                      <ItemImage
                        src={db[item.itemType]?.imageUrl ?? null}
                        alt={label}
                        auditKey={item.name}
                        cls="h-4 w-4"
                      />
                    </span>
                    <span class="flex-1 truncate text-text-secondary" title={label}>{label}</span>
                    <span class={item.missing > 0 ? "text-danger" : "text-success"}>
                      {$tr("syndicates.ownedOfNeeded", {
                        owned: formatNumber(item.owned, $locale),
                        needed: formatNumber(item.needed, $locale),
                      })}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}

            <div class="flex flex-col gap-1">
              {#each totals.standing as pool (pool.bin)}
                <div class="flex items-baseline gap-2 text-xs" data-syndicate-pool={pool.bin}>
                  <span class="flex-1 truncate text-text-secondary">
                    {pool.tags.map((tag) => NAME_BY_TAG.get(tag) ?? tag).join(", ")}
                  </span>
                  <span class="text-text-muted">{formatNumber(pool.needed, $locale)}</span>
                  <span class="whitespace-nowrap text-text-muted">
                    {pool.daysEstimate === 0
                      ? $tr("syndicates.daysToday")
                      : $tr("syndicates.daysEstimate", { days: String(pool.daysEstimate) })}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </ThemedPanel>
      </aside>
    </div>
  {/if}
</section>

<style>
  .standing-track {
    background: color-mix(in srgb, var(--text-muted) 25%, transparent);
  }
  .standing-fill {
    background: var(--accent);
  }
</style>

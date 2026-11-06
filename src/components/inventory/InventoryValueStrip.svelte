<script lang="ts">
  import { PLATINUM_ICON_URL, STAT_ICON_URLS } from "../../lib/assetUrls.js";
  import { locale, tr, type Translator } from "../../lib/i18n.js";
  import {
    VALUE_MIN_PLATINUM_PRESETS,
    selectValueStripRows,
    type InventoryValueTotals,
  } from "../../lib/inventory/valueTotals.js";

  interface Props {
    /** Totals for the rows the tab, its chips and the filters currently show. */
    inView: InventoryValueTotals;
    /** Totals for the whole inventory in the same valuation scope. */
    inventory: InventoryValueTotals;
    allTradables: boolean;
    onSelectScope: (allTradables: boolean) => void;
    /** Per-unit platinum floor applied to both figures; 0 is off. */
    minPlatinum: number;
    onSelectMinPlatinum: (minPlatinum: number) => void;
  }

  let { inView, inventory, allTradables, onSelectScope, minPlatinum, onSelectMinPlatinum }: Props =
    $props();

  const PLAT_ICON = PLATINUM_ICON_URL;
  const DUCAT_ICON = STAT_ICON_URLS.ducatsDelta;

  const rows = $derived(
    selectValueStripRows(inView, inventory).map((key) => ({
      key,
      label:
        key === "inView" ? $tr("inventory.value.inView") : $tr("inventory.value.wholeInventory"),
      totals: key === "inView" ? inView : inventory,
    })),
  );

  // A hole means the real total is higher, so the figure reads as a floor. The
  // translator is a parameter because Svelte only tracks $tr where it is textual.
  function figure(value: number, unpriced: number, code: string, t: Translator): string {
    const amount = value.toLocaleString(code);
    return unpriced > 0 ? t("inventory.value.atLeast", { value: amount }) : amount;
  }

  function hasDucats(totals: InventoryValueTotals): boolean {
    return totals.ducats > 0 || totals.ducatsUnpriced > 0;
  }
</script>

{#if rows.length > 0}
  <div
    class="mt-3 mb-3 flex flex-wrap items-center gap-x-5 gap-y-2"
    data-inventory-value-strip
    title={$tr("inventory.value.hint")}
  >
    <span class="text-xs font-semibold tracking-wide text-text-muted uppercase">
      {$tr("inventory.value.title")}
    </span>

    {#each rows as row, index (row.key)}
      <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1" data-value-scope={row.key}>
        <span
          class="text-xs font-semibold {index === 0 ? 'text-text-secondary' : 'text-text-muted'}"
        >
          {row.label}
        </span>
        <span
          class="inline-flex items-baseline gap-1 font-display font-bold {index === 0
            ? 'text-base text-accent-bright'
            : 'text-sm text-text-secondary'}"
          data-value-platinum
        >
          <img src={PLAT_ICON} alt="" class="h-3.5 w-3.5 shrink-0 self-center object-contain" />
          {figure(row.totals.platinum, row.totals.platinumUnpriced, $locale, $tr)}
        </span>
        {#if hasDucats(row.totals)}
          <span
            class="inline-flex items-baseline gap-1 font-display font-bold {index === 0
              ? 'text-base text-accent'
              : 'text-sm text-text-secondary'}"
            data-value-ducats
          >
            <img src={DUCAT_ICON} alt="" class="h-3.5 w-3.5 shrink-0 self-center object-contain" />
            {figure(row.totals.ducats, row.totals.ducatsUnpriced, $locale, $tr)}
          </span>
        {/if}
        {#if index === 0 && row.totals.unpriced > 0}
          <span class="text-[11px] text-text-muted" data-value-unpriced>
            {$tr("inventory.value.unpriced", { count: row.totals.unpriced })}
          </span>
        {/if}
      </div>
    {/each}

    <div class="flex flex-wrap items-center gap-2" data-value-calculation-controls>
      <div class="filter-tabs" data-value-scope-toggle>
        <button
          type="button"
          class="filter-tab min-h-7 py-0 text-xs"
          class:active={!allTradables}
          aria-pressed={!allTradables}
          data-value-scope-option="prime"
          title={$tr("inventory.value.scopePrimeHint")}
          onclick={() => onSelectScope(false)}
        >
          {$tr("inventory.value.scopePrime")}
        </button>
        <button
          type="button"
          class="filter-tab min-h-7 py-0 text-xs"
          class:active={allTradables}
          aria-pressed={allTradables}
          data-value-scope-option="tradable"
          title={$tr("inventory.value.allTradablesHint")}
          onclick={() => onSelectScope(true)}
        >
          {$tr("inventory.value.allTradables")}
        </button>
      </div>

      <!-- The title sits on the group so all four buttons show it; browsers walk
           up to the nearest titled ancestor. -->
      <div
        class="filter-tabs"
        data-value-min-plat-toggle
        title={$tr("inventory.value.minPlatHint")}
      >
        <img
          src={PLAT_ICON}
          alt=""
          class="h-3.5 w-3.5 shrink-0 self-center object-contain opacity-70"
        />
        {#each VALUE_MIN_PLATINUM_PRESETS as preset (preset)}
          <button
            type="button"
            class="filter-tab min-h-7 py-0 text-xs"
            class:active={minPlatinum === preset}
            aria-pressed={minPlatinum === preset}
            aria-label={preset === 0
              ? $tr("inventory.value.minPlatOff")
              : $tr("inventory.value.minPlatOption", { value: preset })}
            data-value-min-plat-option={preset}
            onclick={() => onSelectMinPlatinum(preset)}
          >
            {preset === 0
              ? $tr("inventory.value.minPlatOff")
              : `${preset.toLocaleString($locale)}+`}
          </button>
        {/each}
      </div>
    </div>
  </div>
{/if}

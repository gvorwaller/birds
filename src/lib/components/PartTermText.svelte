<script lang="ts">
  // Text with its bird-part words linked to Parts of a Bird (td-e4c6dd). Plain text and anchors
  // only: never {@html}, the words come from AI notes and Wikipedia.
  import { withReturnTo } from "$lib/navigation-context";
  import { navigationAction } from "$lib/navigation-context.svelte";
  import { partHref, type PartTermSegment } from "$lib/bird-parts/terms";
  import type { NavigationUiState } from "$lib/navigation-context";

  let {
    segments,
    idPrefix,
    accountId,
    returnTo,
    returnLabel,
    ui = null,
  }: {
    segments: PartTermSegment[];
    /** Unique on the page per note or section: a part is linked once per call, so prefix + part is unique. */
    idPrefix: string;
    accountId: number | null | undefined;
    returnTo: string;
    returnLabel: string;
    /** This page's state to restore on the way back (an open Wikipedia section). */
    ui?: NavigationUiState | null;
  } = $props();
</script>

{#each segments as s, i (i)}{#if s.part}{@const id = `${idPrefix}-${s.part}`}<a
      {id}
      class="part-term path-focus-target"
      href={withReturnTo(partHref(s.diagram, s.part), returnTo, undefined, returnLabel)}
      onclick={navigationAction(accountId, { label: "Parts of a Bird", originId: id, ui })}
      >{s.text}<span class="vh">{" (Parts of a Bird)"}</span></a
    >{:else}{s.text}{/if}{/each}

<style>
  .part-term {
    text-decoration-line: underline;
    text-decoration-style: dotted;
    text-decoration-thickness: 1px;
    text-underline-offset: 2px;
  }
  .vh {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }
</style>

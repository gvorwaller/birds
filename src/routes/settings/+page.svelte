<script lang="ts">
  import { deserialize, enhance } from "$app/forms";
  import Badge from "$components/Badge.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import { invalidateAll } from "$app/navigation";
  import { jobsPoll } from "$lib/job-poll.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let busy = $state("");
  let homePick = $state<PickedLocation | null>(null);

  // Syncs are background jobs now — track a freshly queued one so the
  // layout chip and job history pick it up within one poll tick.
  $effect(() => {
    const q = form && "queued" in form && form.queued ? form.queued : null;
    if (q) jobsPoll.track(q.jobId);
  });

  // --- Web Push enrollment for THIS device (need alerts) -----------------
  let pushBusy = $state(false);
  let pushMessage = $state("");

  function base64UrlToUint8Array(base64Url: string): Uint8Array {
    const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
    const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function enrollThisDevice() {
    pushMessage = "";
    if (!data.vapidPublicKey) {
      pushMessage = "Push isn't configured on the server (missing VAPID keys).";
      return;
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      // iOS exposes PushManager only inside the INSTALLED (Home Screen) app.
      pushMessage =
        "This browser can't receive pushes. On iPhone: open the birds app you added to your Home Screen and enable it there (Share → Add to Home Screen if you haven't).";
      return;
    }
    pushBusy = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        pushMessage =
          "Notifications are blocked for this app — allow them in your device settings, then try again.";
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(data.vapidPublicKey) as BufferSource,
      });
      const body = new FormData();
      body.set("subscription", JSON.stringify(subscription.toJSON()));
      // deserialize, not res.ok: a SvelteKit action fail() arrives as
      // HTTP 200 {type:"failure"} under this fetch's content negotiation —
      // res.ok alone reported rejected saves as enrolled (GROK).
      const res = await fetch("?/save_push_sub", {
        method: "POST",
        body,
        headers: { "x-sveltekit-action": "true" },
      });
      const result = deserialize(await res.text());
      if (result.type === "failure") {
        const data = result.data as { error?: string } | undefined;
        throw new Error(data?.error ?? `save rejected (${result.status})`);
      }
      if (result.type !== "success") {
        throw new Error(`save failed (${res.status})`);
      }
      pushMessage = "This device is enrolled — send a test notification to confirm.";
      await invalidateAll();
    } catch (err) {
      pushMessage = `Couldn't enable notifications: ${err instanceof Error ? err.message : "unknown error"}.`;
    } finally {
      pushBusy = false;
    }
  }

  let revealedKey = $derived(
    form && "apiKey" in form ? (form as { apiKey: string }).apiKey : null,
  );

  let seenTotal = $derived(data.seenBySource.reduce((a, s) => a + s.n, 0));

  // reset: false keeps the DOM controls as submitted instead of letting
  // enhance's form.reset() revert them to their SSR-time defaults — required
  // for forms whose selects/checkboxes mirror `data.*` (the invalidated data
  // updates, but reset() runs after and Svelte's tracked value already
  // matches, so the revert sticks visually). Secret forms keep the default
  // reset so password fields clear after save.
  function track(name: string, opts?: { reset?: boolean }) {
    return () => {
      busy = name;
      return async ({
        update,
      }: {
        update: (o?: { reset?: boolean }) => Promise<void>;
      }) => {
        await update({ reset: opts?.reset ?? true });
        busy = "";
      };
    };
  }
</script>

<svelte:head>
  <title>Settings — birds</title>
</svelte:head>

<div class="page">
  <header class="page-head">
    <h1>Settings</h1>
    <p class="sub">eBird credentials, home location, and syncs</p>
  </header>

  {#if form && "message" in form && form.message}
    <section class="card"><p class="ok">{form.message}</p></section>
  {/if}
  {#if form && "error" in form && form.error}
    <section class="card"><p class="err" role="alert">{form.error}</p></section>
  {/if}

  <section class="card">
    <h2>
      eBird API key
      {#if data.ebird.api_key_set}<Badge
          kind="seen"
          label="saved"
        />{:else}<Badge kind="need" label="missing" />{/if}
    </h2>
    <p class="muted">
      Free personal key from
      <a href="https://ebird.org/api/keygen" target="_blank" rel="noopener"
        >ebird.org/api/keygen</a
      >. Stored encrypted; used for taxonomy, recent observations, and notables.
    </p>
    <form method="POST" action="?/save_api_key" use:enhance={track("key")}>
      <input
        type="text"
        name="api_key"
        placeholder={data.ebird.api_key_set
          ? "saved — enter to replace"
          : "eBird API key"}
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
      />
      <button type="submit" disabled={busy === "key"}>Save key</button>
    </form>
    {#if data.ebird.api_key_set}
      <div class="actionrow">
        <form
          method="POST"
          action="?/reveal_api_key"
          use:enhance={track("revealkey")}
        >
          <button type="submit" class="link" disabled={busy === "revealkey"}
            >Reveal key</button
          >
        </form>
        <form
          method="POST"
          action="?/clear_api_key"
          use:enhance={track("clearkey")}
        >
          <button
            type="submit"
            class="link danger"
            disabled={busy === "clearkey"}>Remove key</button
          >
        </form>
        {#if revealedKey}
          <code class="revealed">{revealedKey}</code>
        {/if}
      </div>
    {/if}
  </section>

  <section class="card">
    <h2>
      eBird account (life-list sync)
      {#if data.ebird.login_set}<Badge kind="seen" label="saved" />{:else}<Badge
          kind="need"
          label="missing"
        />{/if}
    </h2>
    <p class="muted">
      Your eBird sign-in, stored encrypted, used only to fetch your life list
      (the public API has no life-list endpoint). This rides eBird's website
      login — if Cornell changes it, the sync fails soft and your last synced
      list keeps working.
    </p>
    {#if data.ebird.login_set && data.ebird.login_username}
      <p class="muted saved-as">
        Saved account: <strong>{data.ebird.login_username}</strong>
      </p>
    {/if}
    <form method="POST" action="?/save_login" use:enhance={track("login")}>
      <input
        type="text"
        name="ebird_username"
        placeholder={data.ebird.login_set
          ? "username (enter to replace)"
          : "eBird username"}
        autocomplete="off"
        autocapitalize="none"
      />
      <input
        type="password"
        name="ebird_password"
        placeholder={data.ebird.login_set
          ? "password (enter to replace)"
          : "eBird password"}
        autocomplete="off"
      />
      <button type="submit" disabled={busy === "login"}>Save credentials</button
      >
    </form>
    <div class="syncrow">
      <form
        method="POST"
        action="?/test_login"
        use:enhance={track("testlogin")}
      >
        <button
          type="submit"
          disabled={busy === "testlogin" || !data.ebird.login_set}
        >
          {busy === "testlogin" ? "Testing…" : "Test login"}
        </button>
      </form>
      <form
        method="POST"
        action="?/sync_lifelist"
        use:enhance={track("lifelist")}
      >
        <button
          type="submit"
          disabled={busy === "lifelist" || !data.ebird.login_set}
        >
          {busy === "lifelist"
            ? "Queueing…"
            : "⟳ Sync life list (runs in background)"}
        </button>
      </form>
      {#if data.ebird.login_set}
        <form
          method="POST"
          action="?/clear_login"
          use:enhance={track("clearlogin")}
        >
          <button
            type="submit"
            class="link danger"
            disabled={busy === "clearlogin"}>Remove</button
          >
        </form>
      {/if}
    </div>
    <p class="muted">
      {#if data.ebird.life_list_synced_at}
        Last sync {new Date(data.ebird.life_list_synced_at).toLocaleString()}
        {#if data.ebird.life_list_status === "error"}
          <Badge kind="notable" label="error" /> {data.ebird.life_list_error}
        {/if}
      {:else}
        Never synced.
      {/if}
    </p>
    <details>
      <summary>Fallback: import a CSV instead</summary>
      <p class="muted">
        eBird → My eBird → Download my data, or a life-list export. Replaces the
        synced list.
      </p>
      <form
        method="POST"
        action="?/import_csv"
        enctype="multipart/form-data"
        use:enhance={track("csv")}
      >
        <input type="file" name="csv" accept=".csv,text/csv" />
        <button type="submit" disabled={busy === "csv"}>Import CSV</button>
      </form>
    </details>
  </section>

  <section class="card">
    <h2>Home location</h2>
    <p class="muted">
      Used for distances and the Home view. Search a place or tap the map to
      drop a pin.
      {#if data.home.home_label}
        <br />Current: <strong>{data.home.home_label}</strong>
      {:else if data.home.home_lat != null}
        <br />Current: {data.home.home_lat.toFixed(4)}, {data.home.home_lon?.toFixed(
          4,
        )}
      {/if}
    </p>

    <MapPicker
      bind:selected={homePick}
      initialLat={data.home.home_lat}
      initialLng={data.home.home_lon}
    />

    <form
      method="POST"
      action="?/save_home"
      use:enhance={track("home")}
      class="savehome"
    >
      <input
        type="hidden"
        name="home_lat"
        value={homePick?.lat ?? data.home.home_lat ?? ""}
      />
      <input
        type="hidden"
        name="home_lon"
        value={homePick?.lng ?? data.home.home_lon ?? ""}
      />
      <input
        type="hidden"
        name="home_label"
        value={homePick?.label ?? data.home.home_label ?? ""}
      />
      <input
        type="hidden"
        name="home_google_place_id"
        value={homePick?.place_id ?? data.home.home_google_place_id ?? ""}
      />
      <button
        type="submit"
        disabled={busy === "home" || (!homePick && data.home.home_lat == null)}
      >
        {busy === "home"
          ? "Saving…"
          : homePick
            ? `Save: ${homePick.label}`
            : "Save home"}
      </button>
    </form>
  </section>

  <section class="card">
    <h2>Search radius</h2>
    <p class="muted">
      How far around your home (or a searched place) Home looks for reports.
      eBird caps this at 50 km. Searching a place or opening a link with an
      explicit radius changes that view only — this saved value is the default.
    </p>
    <form
      method="POST"
      action="?/save_radius"
      use:enhance={track("radius", { reset: false })}
      class="radius-form"
    >
      <label>
        <span>Default radius</span>
        <select name="near_me_radius_km">
          {#each data.radiusOptionsKm as km (km)}
            <option value={km} selected={data.radiusKm === km}>{km} km</option>
          {/each}
        </select>
      </label>
      <button type="submit" disabled={busy === "radius"}>
        {busy === "radius" ? "Saving…" : "Save radius"}
      </button>
    </form>
  </section>

  <section class="card">
    <h2>
      Need alerts
      {#if data.alerts.enabled}<Badge kind="seen" label="on" />{:else}<Badge
          kind="need"
          label="off"
        />{/if}
    </h2>
    <p class="muted">
      A notification from this app when a
      <strong>rare bird you still need</strong> is reported near your home —
      checked every 30 minutes in the background. Notifications come from the
      birds app itself: enable them on each device you want alerted. Quiet
      hours are your phone's Focus schedule — allow the birds app through any
      Focus you want a rarity to break. Past alerts persist on the
      <a href="/alerts">Alerts page</a>.
    </p>
    {#if data.home.home_lat == null}
      <p class="muted">
        ⚠ Alerts need a home location — set one in the Home section above.
      </p>
    {/if}
    <div class="pushrow">
      <button
        type="button"
        onclick={enrollThisDevice}
        disabled={pushBusy}
      >
        {pushBusy ? "Enabling…" : "🔔 Enable notifications on this device"}
      </button>
      <span class="muted">
        {data.pushDeviceCount} device{data.pushDeviceCount === 1 ? "" : "s"} enrolled
      </span>
    </div>
    {#if pushMessage}
      <p class="muted">{pushMessage}</p>
    {/if}
    <form
      method="POST"
      action="?/save_alerts"
      use:enhance={track("alerts", { reset: false })}
      class="alerts-form"
    >
      <label>
        <span>Alert radius</span>
        <select name="radius_km">
          {#each [10, 20, 30, 40, 50] as km (km)}
            <option value={km} selected={data.alerts.radius_km === km}>{km} km</option>
          {/each}
        </select>
      </label>
      <label>
        <span>Re-alert same species after</span>
        <select name="realert_days">
          {#each [3, 7, 14] as d (d)}
            <option value={d} selected={data.alerts.realert_days === d}>{d} days</option>
          {/each}
        </select>
      </label>
      <label class="inline">
        <input type="checkbox" name="enabled" value="1" checked={data.alerts.enabled} />
        <span>Enable need alerts</span>
      </label>
      <div class="alerts-actions">
        <button type="submit" disabled={busy === "alerts"}>
          {busy === "alerts" ? "Saving…" : "Save alerts"}
        </button>
        <button
          type="submit"
          class="secondary"
          formaction="?/test_push"
          disabled={busy === "alerts"}
        >
          Send test notification
        </button>
      </div>
    </form>
  </section>

  <section class="card">
    <h2>Data & syncs</h2>
    <div class="obs">
      <div class="grow">
        <div class="name">eBird taxonomy</div>
        <div class="meta">
          {data.taxonomyCount} taxa cached
          {#if data.taxonomyNewest}· last synced {new Date(
              data.taxonomyNewest,
            ).toLocaleString()}{/if}
          — needed for species matching. Re-sync quarterly.
        </div>
      </div>
      <form method="POST" action="?/sync_taxonomy" use:enhance={track("tax")}>
        <button
          type="submit"
          disabled={busy === "tax" || !data.ebird.api_key_set}
        >
          {busy === "tax" ? "Queueing…" : "⟳ Sync"}
        </button>
      </form>
    </div>
    <div class="obs">
      <div class="grow">
        <div class="name">Life list</div>
        <div class="meta">
          {#each data.seenBySource as s (s.source)}
            {s.n} via {s.source}&ensp;
          {:else}
            empty
          {/each}
          {#if data.ebird.life_list_synced_at}
            · last synced {new Date(
              data.ebird.life_list_synced_at,
            ).toLocaleString()}
          {/if}
        </div>
      </div>
    </div>
    {#if data.hasGallery}
      <div class="obs">
        <div class="grow">
          <div class="name">Gallery links (gaylon.photos)</div>
          <div class="meta">
            {data.photoTotal} photos, {data.photoMatched} matched to species
            {#if data.photoNewest}· last synced {new Date(
                data.photoNewest,
              ).toLocaleString()}{/if}
          </div>
        </div>
        <form
          method="POST"
          action="?/sync_gallery"
          use:enhance={track("gallery")}
        >
          <button type="submit" disabled={busy === "gallery"}>
            {busy === "gallery" ? "Syncing…" : "⟳ Sync"}
          </button>
        </form>
      </div>
    {/if}
  </section>

  <section class="card">
    <h2>Tools &amp; data</h2>
    <div class="obs">
      <div class="grow">
        <div class="name">eBird response cache</div>
        <div class="meta">
          {data.cacheRows} cached {data.cacheRows === 1
            ? "response"
            : "responses"}
          {#if data.cacheNewest}· newest {new Date(
              data.cacheNewest,
            ).toLocaleString()}{/if}
          {#if data.cacheRows === 0}· empty{/if}
        </div>
      </div>
      <form method="POST" action="?/flush_cache" use:enhance={track("flush")}>
        <button
          type="submit"
          disabled={busy === "flush" || data.cacheRows === 0}
        >
          {busy === "flush" ? "Clearing…" : "Flush cache"}
        </button>
      </form>
    </div>
    <div class="obs">
      <div class="grow">
        <div class="name">At a glance</div>
        <div class="meta">
          {data.taxonomyCount} taxa · {seenTotal} life-list species · {data.photoMatched}/{data.photoTotal}
          photos matched · {data.tripCount}
          {data.tripCount === 1 ? "trip" : "trips"} · {data.tripStopCount}
          {data.tripStopCount === 1 ? "stop" : "stops"}
        </div>
      </div>
    </div>
  </section>

  {#if data.isAdmin}
    <section class="card">
      <h2>Users</h2>
      <p class="sub2">
        Provision family accounts. Each user sees only their own data.
      </p>
      {#each data.users as u (u.id)}
        <div class="obs user-row">
          <div class="grow">
            <div class="name">
              {u.display_name}
              <span class="muted">@{u.username}</span>
              <Badge kind="seen" label={u.role} />
              {#if u.views_user_id}<Badge
                  kind="notable"
                  label="views #{u.views_user_id}"
                />{/if}
              {#if u.has_gallery}<Badge kind="seen" label="gallery" />{/if}
            </div>
            <div class="meta">
              {#if u.last_login_at}last login {new Date(
                  u.last_login_at,
                ).toLocaleDateString()}{:else}never logged in{/if}
            </div>
          </div>
          <form
            method="POST"
            action="?/set_user_password"
            use:enhance={track(`pw-${u.id}`)}
            class="pw-form"
          >
            <input type="hidden" name="user_id" value={u.id} />
            <input
              type="password"
              name="password"
              placeholder="New password"
              minlength="8"
              required
            />
            <button type="submit" disabled={busy === `pw-${u.id}`}>Set</button>
          </form>
        </div>
      {/each}

      <details class="add-user">
        <summary>+ Add a user</summary>
        <form
          method="POST"
          action="?/create_user"
          use:enhance={track("create-user")}
          class="create-form"
        >
          <label
            ><span>Username</span><input
              type="text"
              name="new_username"
              placeholder="marcus"
              required
            /></label
          >
          <label
            ><span>Display name</span><input
              type="text"
              name="new_display_name"
              placeholder="Marcus"
              required
            /></label
          >
          <label
            ><span>Role</span>
            <select name="new_role">
              <option value="user">user — own data</option>
              <option value="viewer">viewer — read-only of an owner</option>
              <option value="admin">admin — own data + user management</option>
            </select>
          </label>
          <label
            ><span>Password</span><input
              type="password"
              name="new_password"
              placeholder="8+ characters"
              minlength="8"
              required
            /></label
          >
          <button type="submit" disabled={busy === "create-user"}
            >Create user</button
          >
        </form>
      </details>
    </section>
  {/if}

  <section class="card">
    <h2>Session</h2>
    <form method="POST" action="/login?/logout">
      <button type="submit" class="danger">Sign out</button>
    </form>
  </section>
</div>

<style>
  .page {
    max-width: 720px;
    margin: 0 auto;
    padding: 16px;
  }
  .page-head {
    margin: 4px 0 16px;
  }
  h1 {
    font-size: 1.4rem;
  }
  .sub,
  .muted {
    color: var(--muted);
    font-size: 0.89rem;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .card h2 {
    font-size: 1.05rem;
    margin-bottom: 8px;
  }
  .card p.muted {
    margin-bottom: 10px;
  }
  form {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }
  input[type="text"],
  input[type="password"],
  input[type="file"] {
    flex: 1;
    min-width: 200px;
    min-height: 48px;
    padding: 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--bg);
    color: var(--text);
  }
  button {
    min-height: 48px;
    padding: 10px 18px;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    font-weight: 600;
  }
  button:disabled {
    opacity: 0.5;
  }
  button.danger {
    background: var(--card);
    border-color: #d9a5ab;
    color: var(--danger);
  }
  .syncrow {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 12px;
  }
  details {
    margin-top: 12px;
  }
  details summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 0.89rem;
    min-height: 44px;
    display: flex;
    align-items: center;
  }
  details form {
    margin-top: 8px;
  }
  .obs {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 0;
    border-top: 1px solid var(--border);
  }
  .obs:first-of-type {
    border-top: none;
  }
  .sub2 {
    color: var(--muted);
    font-size: 0.85rem;
    margin-bottom: 8px;
  }
  .user-row {
    flex-wrap: wrap;
  }
  .user-row .name :global(.badge) {
    margin-left: 4px;
  }
  .pw-form {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .pw-form input {
    min-height: 40px;
    padding: 6px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 16px;
  }
  .add-user {
    margin-top: 12px;
    border-top: 1px solid var(--border);
    padding-top: 12px;
  }
  .add-user summary {
    cursor: pointer;
    color: var(--link);
    font-weight: 600;
    min-height: 36px;
    display: flex;
    align-items: center;
  }
  .create-form {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    align-items: flex-end;
    margin-top: 10px;
  }
  .create-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
  }
  .create-form input,
  .create-form select {
    min-height: 44px;
    padding: 8px 10px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background: var(--card);
    color: var(--text);
    font-size: 16px;
  }
  .grow {
    flex: 1;
    min-width: 0;
  }
  .name {
    font-weight: 700;
  }
  .meta {
    color: var(--muted);
    font-size: 0.83rem;
    margin-top: 2px;
  }
  .ok {
    color: var(--seen-text);
    font-weight: 600;
  }
  .err {
    color: var(--danger);
    font-weight: 600;
  }
  .actionrow {
    display: flex;
    gap: 16px;
    align-items: center;
    flex-wrap: wrap;
    margin-top: 10px;
  }
  .actionrow form {
    display: inline;
  }
  button.link {
    min-height: auto;
    padding: 4px 0;
    background: none;
    border: none;
    color: var(--link);
    font-weight: 600;
    font-size: 0.85rem;
    text-decoration: underline;
  }
  button.link.danger {
    color: var(--danger);
    border: none;
    background: none;
  }
  .revealed {
    font-size: 0.85rem;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 8px;
    word-break: break-all;
  }
  .saved-as {
    margin-bottom: 10px;
  }
  .pushrow {
    display: flex;
    flex-wrap: wrap;
    gap: 12px;
    align-items: center;
    margin: 8px 0 12px;
  }
  .alerts-form {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 480px;
  }
  .alerts-form label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
  }
  .alerts-form label span {
    min-width: 150px;
  }
  .alerts-form select {
    /* Safari ignores min-height on NATIVE selects (measured 26px, GROK) —
       appearance:none makes the box honor it; the chevron is re-added
       inline since appearance:none strips the native arrow. 16px font also
       prevents iOS zoom-on-focus. */
    appearance: none;
    -webkit-appearance: none;
    min-height: 48px;
    padding: 8px 32px 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background-color: var(--bg);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23495057' stroke-width='2' fill='none'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    color: var(--text);
    font-size: 16px;
  }
  .alerts-form label.inline {
    min-height: 48px;
  }
  .alerts-form label.inline input[type="checkbox"] {
    width: 22px;
    height: 22px;
    accent-color: var(--accent);
  }
  .alerts-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
  }
  .alerts-actions .secondary {
    background: var(--card);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
  .radius-form label {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--muted);
    font-size: 0.83rem;
    font-weight: 600;
  }
  .radius-form select {
    /* Same Safari native-select fix as .alerts-form select. */
    appearance: none;
    -webkit-appearance: none;
    min-height: 48px;
    padding: 8px 32px 8px 12px;
    border: 1px solid var(--border);
    border-radius: 8px;
    background-color: var(--bg);
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%23495057' stroke-width='2' fill='none'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    color: var(--text);
    font-size: 16px;
  }
  .savehome {
    margin-top: 12px;
  }
  @media (min-width: 640px) {
    .page {
      padding: 24px;
    }
    h1 {
      font-size: 1.6rem;
    }
  }
</style>

<script lang="ts">
  import { enhance } from "$app/forms";
  import Badge from "$components/Badge.svelte";
  import MapPicker, { type PickedLocation } from "$components/MapPicker.svelte";
  import type { ActionData, PageData } from "./$types";

  let { data, form }: { data: PageData; form: ActionData } = $props();
  let busy = $state("");
  let homePick = $state<PickedLocation | null>(null);

  let revealedKey = $derived(
    form && "apiKey" in form ? (form as { apiKey: string }).apiKey : null,
  );

  let seenTotal = $derived(data.seenBySource.reduce((a, s) => a + s.n, 0));

  function track(name: string) {
    return () => {
      busy = name;
      return async ({ update }: { update: () => Promise<void> }) => {
        await update();
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
            ? "Syncing… (logs into eBird)"
            : "⟳ Sync life list now"}
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
      Used for distances and the Near Me view. Search a place or tap the map to
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
          {busy === "tax" ? "Syncing…" : "⟳ Sync"}
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

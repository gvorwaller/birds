import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import MapLink from './MapLink.svelte';

describe('MapLink rendered checklist contract', () => {
  it('renders a checklist without map coordinates', () => {
    const { body } = render(MapLink, { props: { subId: 'S100' } });
    expect(body).toContain('href="https://ebird.org/checklist/S100"');
    expect(body).toContain('target="_blank" rel="noopener"');
    expect(body).not.toContain('Directions');
  });

  it('does not manufacture a checklist when its ID is missing', () => {
    const { body } = render(MapLink, { props: { lat: 30, lng: -81 } });
    expect(body).toContain('Directions');
    expect(body).not.toContain('ebird.org/checklist/');
  });

  it('encodes the checklist ID as one URL path segment', () => {
    const { body } = render(MapLink, { props: { subId: 'S100/?"' } });
    expect(body).toContain('https://ebird.org/checklist/S100%2F%3F%22');
  });

  it('renders no links when both location and checklist are absent', () => {
    expect(render(MapLink, { props: {} }).body).not.toContain('<a');
  });
});

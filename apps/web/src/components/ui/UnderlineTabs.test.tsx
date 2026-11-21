import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { UnderlineTabs } from './UnderlineTabs';

type Id = 'dashboard' | 'report' | 'files';
const TABS = [
  { id: 'dashboard' as const, label: 'Dashboard' },
  { id: 'report' as const, label: 'Report' },
  { id: 'files' as const, label: 'Files', count: 3 },
];

function Tabs({ start = 'dashboard' }: { start?: Id }) {
  const [open, setOpen] = useState<Id>(start);
  return <UnderlineTabs label="Machine sections" tabs={TABS} value={open} onChange={setOpen} idPrefix="t" />;
}

const tab = (name: string | RegExp) => screen.getByRole('tab', { name });

/** Presses a key on the focused tab, and expects the tab with `name` to be focused and open */
function pressAndExpect(key: string, name: string | RegExp) {
  fireEvent.keyDown(document.activeElement as Element, { key });
  expect(tab(name)).toHaveFocus();
  expect(tab(name)).toHaveAttribute('aria-selected', 'true');
}

describe('UnderlineTabs', () => {
  afterEach(cleanup);

  it('lets only the open tab take the focus with the Tab key', () => {
    render(<Tabs start="report" />);

    expect(tab('Report')).toHaveAttribute('tabindex', '0');
    expect(tab('Dashboard')).toHaveAttribute('tabindex', '-1');
    expect(tab('Files 3')).toHaveAttribute('tabindex', '-1');
  });

  it('opens the next tab with the Right arrow, and goes from the last tab to the first', () => {
    render(<Tabs />);
    tab('Dashboard').focus();

    pressAndExpect('ArrowRight', 'Report');
    pressAndExpect('ArrowRight', 'Files 3');
    pressAndExpect('ArrowRight', 'Dashboard');
    expect(tab('Dashboard')).toHaveAttribute('tabindex', '0');
  });

  it('opens the tab before with the Left arrow, and goes from the first tab to the last', () => {
    render(<Tabs />);
    tab('Dashboard').focus();

    pressAndExpect('ArrowLeft', 'Files 3');
    pressAndExpect('ArrowLeft', 'Report');
  });

  it('opens the first tab with Home', () => {
    render(<Tabs start="files" />);
    tab('Files 3').focus();

    pressAndExpect('Home', 'Dashboard');
  });

  it('opens the last tab with End', () => {
    render(<Tabs />);
    tab('Dashboard').focus();

    pressAndExpect('End', 'Files 3');
  });

  it('does nothing for the other keys', () => {
    render(<Tabs />);
    tab('Dashboard').focus();

    fireEvent.keyDown(tab('Dashboard'), { key: 'ArrowDown' });

    expect(tab('Dashboard')).toHaveFocus();
    expect(tab('Dashboard')).toHaveAttribute('aria-selected', 'true');
  });

  it('puts the tabs that do not fit on a new line, so no tab hides out of view on a phone', () => {
    render(<Tabs />);

    // jsdom has no layout, so the test reads the classes: the row wraps, and it does not scroll
    const tablist = screen.getByRole('tablist');
    expect(tablist).toHaveClass('flex-wrap');
    expect(tablist).not.toHaveClass('overflow-x-auto');
  });
});

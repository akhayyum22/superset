/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

/**
 * Regression coverage for the Drill to Detail modal's results table.
 *
 * The drill pane measures its available height with a resize detector and
 * hands it to a virtualized table, so the rows only render if the modal's
 * internal height chain (resizable wrapper -> modal container -> modal body ->
 * flex pane) actually resolves to a real height. That chain is wired together
 * with CSS selectors targeting Ant Design's internal modal classes, which
 * TypeScript cannot see and unit tests do not exercise: when the antd v6
 * upgrade renamed `.ant-modal-content` to `.ant-modal-container`, the chain
 * silently broke, the pane measured ~0, and the table briefly flashed its rows
 * before collapsing to an empty body with only the header and pagination
 * visible.
 *
 * Only a real browser sees layout, so this is pinned here rather than in the
 * DOM-contract unit suite. Because the failure mode is
 * render-then-collapse, a single "rows are visible" read could pass during
 * the initial flash — the assertion therefore lets the height settle once,
 * then requires it to hold across further spaced reads with no more
 * retrying, so a later or partial collapse cannot be masked by an early-exit
 * retry that stopped at the first passing sample.
 *
 * CI green => the drill modal's table renders rows at a stable, non-collapsed
 *             height.
 * CI red   => the modal height chain broke again (or drill-to-detail failed to
 *             open/load at all).
 */
import type { Page } from '@playwright/test';
import { testWithAssets, expect } from '../../helpers/fixtures';
import { TIMEOUT } from '../../utils/constants';
import { DashboardPage } from '../../pages/DashboardPage';
import { Menu } from '../../components/core';
import { createDashboardWithCharts } from './dashboard-test-helpers';

const MIN_STABLE_BODY_HEIGHT = 100;
// Max fraction the body height may drift from the settled baseline below; a
// partial collapse (e.g. 400px -> 150px) still clears MIN_STABLE_BODY_HEIGHT
// but fails this, so the check enforces stability, not just a floor.
const HEIGHT_DRIFT_TOLERANCE = 0.25;
// Extra spaced reads taken *after* the height has settled, and the gap
// between them. These are plain assertions, not wrapped in a retrying
// helper: once settled, a retry would return on the first passing sample
// and could mask a collapse that only shows up later in the window.
const HEIGHT_SAMPLE_COUNT = 2;
const HEIGHT_SAMPLE_INTERVAL_MS = 300;

testWithAssets(
  'drill to detail modal renders result rows at a stable height',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);

    const { dashboardId } = await createDashboardWithCharts(
      page,
      testAssets,
      testWithAssets.info(),
      {
        datasetName: 'birth_names',
        chartNamePrefix: 'drill_detail',
        dashboardTitlePrefix: 'drill_detail_modal',
        chartSpecs: [
          {
            viz_type: 'pie',
            params: {
              groupby: ['gender'],
              metric: 'count',
            },
          },
        ],
      },
    );

    const dashboard = new DashboardPage(page);
    await dashboard.gotoById(dashboardId);
    await dashboard.waitForLoad();
    await dashboard.waitForChartsToLoad();

    // Open the chart context menu. The ECharts canvas exposes no data-test
    // hooks for its regions, so right-click the centre of the chart container;
    // the exact-text match below then works whether the click landed on a
    // slice (which adds "Drill to detail by" items) or on the chart background.
    // The first right-click after load can be swallowed by a chart re-render
    // closing the menu, so retry the click until the menu actually shows.
    const chart = page.locator('[data-test="chart-container"]').first();
    await chart.scrollIntoViewIfNeeded();
    const contextMenu = page.locator('[data-test="chart-context-menu"]');
    await expect(async () => {
      const box = await chart.boundingBox();
      if (!box) {
        throw new Error('chart container has no bounding box');
      }
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, {
        button: 'right',
      });
      await expect(contextMenu).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: TIMEOUT.CHART_RENDER });
    await page
      .getByRole('menuitem', { name: 'Drill to detail', exact: true })
      .click();

    const modal = page.locator('.ant-modal:visible');
    await expect(modal).toBeVisible({ timeout: TIMEOUT.FORM_LOAD });

    // Wait for the samples request to resolve into a rendered table: the row
    // count pill and the virtualized body both come from the loaded page.
    const tableBody = modal.locator('.virtual-grid');
    await expect(tableBody).toBeAttached({ timeout: TIMEOUT.CHART_RENDER });

    // The regression collapses the body *after* first paint, so first let the
    // height settle above the floor (retrying is safe here: the collapse is
    // persistent, so a broken build never finds a passing read and this
    // still times out red), then, without any further retrying, take extra
    // spaced reads and require each to hold within tolerance of that settled
    // baseline — a delayed or partial collapse can no longer be masked by an
    // early-exit retry that stopped at the first passing sample.
    let baselineHeight = 0;
    await expect
      .poll(
        async () => {
          baselineHeight = (await tableBody.boundingBox())?.height ?? 0;
          return baselineHeight;
        },
        { timeout: TIMEOUT.CHART_RENDER },
      )
      .toBeGreaterThan(MIN_STABLE_BODY_HEIGHT);
    for (let sample = 0; sample < HEIGHT_SAMPLE_COUNT; sample += 1) {
      // eslint-disable-next-line no-await-in-loop -- reads must be sequential
      // and spaced out to observe a delayed collapse; there is nothing to
      // parallelize.
      await page.waitForTimeout(HEIGHT_SAMPLE_INTERVAL_MS);
      // eslint-disable-next-line no-await-in-loop -- see above
      const box = await tableBody.boundingBox();
      const height = box?.height ?? 0;
      expect(height).toBeGreaterThan(MIN_STABLE_BODY_HEIGHT);
      expect(Math.abs(height - baselineHeight)).toBeLessThanOrEqual(
        baselineHeight * HEIGHT_DRIFT_TOLERANCE,
      );
    }

    // And the rows are real data, not just an expanded empty scroller:
    // birth_names sample rows always carry a gender value.
    await expect(modal.getByText(/^(boy|girl)$/).first()).toBeVisible({
      timeout: TIMEOUT.API_RESPONSE,
    });
  },
);

/**
 * The journeys below are the Playwright port of the skipped Cypress spec that
 * lived at `cypress-base/cypress/e2e/dashboard/drilltodetail.test.ts`: opening
 * the modal from a chart's menu, paginating and reloading the samples, drilling
 * by a dimension value, and clearing the resulting filter.
 *
 * The Cypress version drove ECharts canvases by hard-coded pixel offsets, which
 * is what left it disabled ("issues with autoscrolling and the locked title").
 * A Table chart exposes its dimension values as real DOM cells, so the same
 * drill-by-value behaviour can be triggered by right-clicking the cell that
 * holds the value under test — no coordinate arithmetic, no arbitrary waits.
 */
const DRILL_MODAL = '.ant-modal:visible';
const FIRST_PAGE_ITEM = '.ant-pagination-item-1';
const SECOND_PAGE_ITEM = '.ant-pagination-item-2';
const ACTIVE_PAGE_ITEM = '.ant-pagination-item-active';
const VIRTUAL_CELL = '.virtual-table-cell';
const VIRTUAL_GRID = '.virtual-grid';

/**
 * Builds a dashboard holding a single Table chart aggregated by `gender`, so the
 * rendered chart contains a `boy` and a `girl` cell to right-click.
 */
async function createTableChartDashboard(
  page: Page,
  testAssets: Parameters<typeof createDashboardWithCharts>[1],
  testInfo: Parameters<typeof createDashboardWithCharts>[2],
): Promise<{ dashboardId: number; chartId: number; sliceName: string }> {
  const { dashboardId, charts } = await createDashboardWithCharts(
    page,
    testAssets,
    testInfo,
    {
      datasetName: 'birth_names',
      chartNamePrefix: 'drill_detail',
      dashboardTitlePrefix: 'drill_detail_journeys',
      chartSpecs: [
        {
          viz_type: 'table',
          params: {
            query_mode: 'aggregate',
            groupby: ['gender'],
            metrics: ['count'],
            row_limit: 10,
          },
        },
      ],
    },
  );
  return {
    dashboardId,
    chartId: charts[0].id,
    sliceName: charts[0].sliceName,
  };
}

/** Loads a dashboard and waits for its charts to paint. */
async function openDashboard(page: Page, dashboardId: number): Promise<void> {
  const dashboard = new DashboardPage(page);
  await dashboard.gotoById(dashboardId);
  await dashboard.waitForLoad();
  await dashboard.waitForChartsToLoad({ timeout: TIMEOUT.CHART_RENDER });
}

testWithAssets(
  'drill to detail opens from the chart menu, paginates and reloads',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);

    const { dashboardId, chartId, sliceName } = await createTableChartDashboard(
      page,
      testAssets,
      testWithAssets.info(),
    );
    await openDashboard(page, dashboardId);

    await page
      .getByRole('button', { name: 'More Options', exact: true })
      .first()
      .click();
    await new Menu(page, `[data-test="slice_${chartId}-menu"]`).selectItem(
      'Drill to detail',
    );

    // The modal is titled after the chart it drilled from, and drilling from the
    // chart menu carries no dimension filters.
    const modal = page.locator(DRILL_MODAL);
    await expect(modal.getByText(`Drill to detail: ${sliceName}`)).toBeVisible({
      timeout: TIMEOUT.FORM_LOAD,
    });
    await expect(modal.getByTestId('filter-val')).toHaveCount(0);

    // Samples are the dataset's raw rows, so the row count reads in thousands
    // and the results span more pages than fit in one page of rows.
    await expect(modal.getByTestId('row-count-label')).toContainText('rows', {
      timeout: TIMEOUT.CHART_RENDER,
    });
    const grid = modal.locator(VIRTUAL_GRID);
    await expect(modal.locator(VIRTUAL_CELL).first()).toBeVisible({
      timeout: TIMEOUT.API_RESPONSE,
    });
    const firstPageRows = await grid.innerText();

    // Paging fetches a different slice of the samples...
    await modal.locator(SECOND_PAGE_ITEM).click();
    await expect(modal.locator(ACTIVE_PAGE_ITEM)).toHaveText('2');
    await expect
      .poll(() => grid.innerText(), { timeout: TIMEOUT.API_RESPONSE })
      .not.toBe(firstPageRows);

    // ...and reloading starts the results over from the first page.
    await modal.getByLabel('Reload').click();
    await expect(modal.locator(ACTIVE_PAGE_ITEM)).toHaveText('1', {
      timeout: TIMEOUT.API_RESPONSE,
    });
    await expect
      .poll(() => grid.innerText(), { timeout: TIMEOUT.API_RESPONSE })
      .toBe(firstPageRows);
  },
);

testWithAssets(
  'drill to detail by a dimension value filters the samples until the filter is cleared',
  async ({ page, testAssets }) => {
    testWithAssets.setTimeout(TIMEOUT.SLOW_TEST);

    const { dashboardId } = await createTableChartDashboard(
      page,
      testAssets,
      testWithAssets.info(),
    );
    await openDashboard(page, dashboardId);

    const boyCell = page.getByText('boy', { exact: true }).first();
    await boyCell.scrollIntoViewIfNeeded();
    await boyCell.click({ button: 'right' });

    const contextMenu = page.locator('[data-test="chart-context-menu"]');
    await expect(contextMenu).toBeVisible({ timeout: TIMEOUT.UI_TRANSITION });
    await new Menu(page, '[data-test="chart-context-menu"]').selectSubmenuItem(
      'Drill to detail by',
      'Drill to detail by boy',
    );

    // Drilling by a value opens the modal pre-filtered on that value, and the
    // samples it shows are only that value's rows.
    const modal = page.locator(DRILL_MODAL);
    await expect(modal.getByTestId('filter-val')).toHaveText('boy', {
      timeout: TIMEOUT.FORM_LOAD,
    });
    await expect(modal.locator(VIRTUAL_CELL).first()).toBeVisible({
      timeout: TIMEOUT.CHART_RENDER,
    });
    await expect(modal.getByText('girl', { exact: true })).toHaveCount(0);
    const filteredRowCount = await modal
      .getByTestId('row-count-label')
      .innerText();

    // Removing the filter tag re-queries the samples unfiltered: the other
    // dimension value comes back and the row count grows.
    await modal.getByTestId('filter-col').getByLabel('Close').click();
    await expect(modal.getByTestId('filter-val')).toHaveCount(0);
    await expect(modal.getByTestId('row-count-label')).not.toHaveText(
      filteredRowCount,
      { timeout: TIMEOUT.API_RESPONSE },
    );
    await expect(modal.locator(FIRST_PAGE_ITEM)).toHaveClass(
      /ant-pagination-item-active/,
    );
  },
);

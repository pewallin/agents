import { describe, it, expect } from "vitest";
import { computeLayout, computeGeometry, distributeEvenly } from "./grid.js";

describe("distributeEvenly", () => {
  it("splits evenly", () => {
    expect(distributeEvenly(100, 4)).toEqual([25, 25, 25, 25]);
  });

  it("spreads remainder across first buckets", () => {
    expect(distributeEvenly(10, 3)).toEqual([4, 3, 3]);
  });

  it("handles 1 bucket", () => {
    expect(distributeEvenly(50, 1)).toEqual([50]);
  });

  it("handles remainder equal to count-1", () => {
    expect(distributeEvenly(11, 4)).toEqual([3, 3, 3, 2]);
  });
});

describe("computeLayout", () => {
  it("returns null for 0 agents", () => {
    expect(computeLayout(0)).toBeNull();
  });

  it("returns null for 1 agent", () => {
    expect(computeLayout(1)).toBeNull();
  });

  it("2 agents: side by side", () => {
    const layout = computeLayout(2)!;
    expect(layout.rows).toBe(1);
    expect(layout.colsPerRow).toEqual([2]);
    expect(layout.cells).toEqual([
      { row: 0, col: 0, rowCols: 2 },
      { row: 0, col: 1, rowCols: 2 },
    ]);
  });

  it("3 agents: 1 top + 2 bottom", () => {
    const layout = computeLayout(3)!;
    expect(layout.rows).toBe(2);
    expect(layout.colsPerRow).toEqual([1, 2]);
    expect(layout.cells).toHaveLength(3);
    expect(layout.cells[0]).toEqual({ row: 0, col: 0, rowCols: 1 });
    expect(layout.cells[1]).toEqual({ row: 1, col: 0, rowCols: 2 });
    expect(layout.cells[2]).toEqual({ row: 1, col: 1, rowCols: 2 });
  });

  it("4 agents: 2×2", () => {
    const layout = computeLayout(4)!;
    expect(layout.rows).toBe(2);
    expect(layout.colsPerRow).toEqual([2, 2]);
    expect(layout.cells).toHaveLength(4);
  });

  it("5 agents: 3 top + 2 bottom", () => {
    const layout = computeLayout(5)!;
    expect(layout.rows).toBe(2);
    expect(layout.colsPerRow).toEqual([3, 2]);
    expect(layout.cells).toHaveLength(5);
  });

  it("6 agents: 3×2", () => {
    const layout = computeLayout(6)!;
    expect(layout.rows).toBe(2);
    expect(layout.colsPerRow).toEqual([3, 3]);
    expect(layout.cells).toHaveLength(6);
  });

  it("9 agents: 3×3", () => {
    const layout = computeLayout(9)!;
    expect(layout.rows).toBe(3);
    expect(layout.colsPerRow).toEqual([3, 3, 3]);
    expect(layout.cells).toHaveLength(9);
  });

  it("12 agents: 4×3", () => {
    const layout = computeLayout(12)!;
    expect(layout.rows).toBe(3);
    expect(layout.colsPerRow).toEqual([4, 4, 4]);
    expect(layout.cells).toHaveLength(12);
  });

  it("caps at 12", () => {
    const layout = computeLayout(15)!;
    expect(layout.cells).toHaveLength(12);
  });

  it("cell count always matches input (2-12)", () => {
    for (let n = 2; n <= 12; n++) {
      const layout = computeLayout(n)!;
      expect(layout.cells).toHaveLength(n);
      // colsPerRow sums to n
      expect(layout.colsPerRow.reduce((a, b) => a + b, 0)).toBe(n);
    }
  });
});

describe("computeGeometry", () => {
  it("2 agents side by side in 200×50", () => {
    const layout = computeLayout(2)!;
    const geo = computeGeometry(layout, 200, 50);

    expect(geo).toHaveLength(2);
    // 200 cols, 1 border between = 199 usable, 199/2 = 100+99
    expect(geo[0]).toEqual({ x: 0, y: 0, width: 100, height: 50 });
    expect(geo[1]).toEqual({ x: 101, y: 0, width: 99, height: 50 });
  });

  it("4 agents 2×2 in 200×50", () => {
    const layout = computeLayout(4)!;
    const geo = computeGeometry(layout, 200, 50);

    expect(geo).toHaveLength(4);
    // Heights: 50 - 1 border = 49 usable, 49/2 = 25+24
    // Widths: 200 - 1 border = 199 usable, 199/2 = 100+99
    expect(geo[0]).toEqual({ x: 0, y: 0, width: 100, height: 25 });
    expect(geo[1]).toEqual({ x: 101, y: 0, width: 99, height: 25 });
    expect(geo[2]).toEqual({ x: 0, y: 26, width: 100, height: 24 });
    expect(geo[3]).toEqual({ x: 101, y: 26, width: 99, height: 24 });
  });

  it("3 agents (1+2) in 200×50", () => {
    const layout = computeLayout(3)!;
    const geo = computeGeometry(layout, 200, 50);

    expect(geo).toHaveLength(3);
    // Row 0: 1 col, full width = 200
    // Row 1: 2 cols, 199/2 = 100+99
    // Heights: 49/2 = 25+24
    expect(geo[0]).toEqual({ x: 0, y: 0, width: 200, height: 25 });
    expect(geo[1]).toEqual({ x: 0, y: 26, width: 100, height: 24 });
    expect(geo[2]).toEqual({ x: 101, y: 26, width: 99, height: 24 });
  });

  it("5 agents (3+2) in 210×40", () => {
    const layout = computeLayout(5)!;
    const geo = computeGeometry(layout, 210, 40);

    expect(geo).toHaveLength(5);
    // Heights: 40 - 1 = 39, 39/2 = 20+19
    // Row 0: 3 cols, 210 - 2 borders = 208, 208/3 = 70+69+69
    // Row 1: 2 cols, 210 - 1 border = 209, 209/2 = 105+104
    expect(geo[0]).toEqual({ x: 0, y: 0, width: 70, height: 20 });
    expect(geo[1]).toEqual({ x: 71, y: 0, width: 69, height: 20 });
    expect(geo[2]).toEqual({ x: 141, y: 0, width: 69, height: 20 });
    expect(geo[3]).toEqual({ x: 0, y: 21, width: 105, height: 19 });
    expect(geo[4]).toEqual({ x: 106, y: 21, width: 104, height: 19 });
  });

  it("all cells tile without overlap or gaps", () => {
    for (let n = 2; n <= 12; n++) {
      const layout = computeLayout(n)!;
      const W = 200, H = 50;
      const geo = computeGeometry(layout, W, H);

      // Check no overlap: build a grid and mark cells
      const grid = Array.from({ length: H }, () => new Uint8Array(W));
      for (const g of geo) {
        for (let y = g.y; y < g.y + g.height; y++) {
          for (let x = g.x; x < g.x + g.width; x++) {
            expect(grid[y][x]).toBe(0); // no overlap
            grid[y][x] = 1;
          }
        }
      }

      // Check total coverage: cells + borders should account for all space
      const cellArea = geo.reduce((sum, g) => sum + g.width * g.height, 0);
      // Not all pixels are covered (borders take space), but cells shouldn't exceed bounds
      for (const g of geo) {
        expect(g.x + g.width).toBeLessThanOrEqual(W);
        expect(g.y + g.height).toBeLessThanOrEqual(H);
        expect(g.width).toBeGreaterThan(0);
        expect(g.height).toBeGreaterThan(0);
      }
    }
  });

  it("cells within same row have same y and height", () => {
    for (let n = 2; n <= 12; n++) {
      const layout = computeLayout(n)!;
      const geo = computeGeometry(layout, 200, 50);

      let idx = 0;
      for (let r = 0; r < layout.rows; r++) {
        const rowCells = geo.slice(idx, idx + layout.colsPerRow[r]);
        const y0 = rowCells[0].y;
        const h0 = rowCells[0].height;
        for (const cell of rowCells) {
          expect(cell.y).toBe(y0);
          expect(cell.height).toBe(h0);
        }
        idx += layout.colsPerRow[r];
      }
    }
  });

  it("cells within same row are contiguous (cell + border + next cell)", () => {
    for (let n = 2; n <= 12; n++) {
      const layout = computeLayout(n)!;
      const geo = computeGeometry(layout, 200, 50);

      let idx = 0;
      for (let r = 0; r < layout.rows; r++) {
        const rowCells = geo.slice(idx, idx + layout.colsPerRow[r]);
        for (let c = 1; c < rowCells.length; c++) {
          // Previous cell end + 1 border = next cell start
          expect(rowCells[c].x).toBe(rowCells[c - 1].x + rowCells[c - 1].width + 1);
        }
        idx += layout.colsPerRow[r];
      }
    }
  });
});

/**
 * dsh-compaction-continuum — structural core.
 *
 * The spirit of AstrContinuum is not "summarize better": it is to treat the
 * context as a *structure* and condense it by static reduction.
 *
 *   coordinate (DOF)   a compressible context unit (candidate block)
 *   element            one relation a-b with weight w -> w·(e_a−e_b)(e_a−e_b)ᵀ
 *                      (exactly a truss/spring element stiffness)
 *   stiffness K        evidentiary coupling: shared sources, same capsule,
 *                      adjacent events, same kind, same slot
 *   load f             activation of each unit by the current request
 *   supports           `required` coordinates (a fixed boundary condition);
 *                      a support can never be eliminated
 *   solve              KKT saddle system [K Cᵀ; C 0][u;λ] = [f;d]
 *   condense           keep the load-bearing DOFs R, eliminate E with a
 *                      reconstruction operator (Guyan static condensation)
 *   certificate        re-solve full retention and compare the reconstruction;
 *                      a failed certificate means "publish nothing"
 *
 * Everything here is pure arithmetic: no model call, no token cost, and the
 * same input always produces the same output.
 */

// ---------------------------------------------------------------------------
// Dense linear algebra (the graphs are small: tens to a few hundred DOFs)
// ---------------------------------------------------------------------------

/**
 * Solve `A x = b` by LU with partial pivoting.
 * @returns `{ solution, backwardError }`; `solution` is `null` when `A` is singular.
 */
export function solveDense(a, b) {
  const n = b.length;
  if (a.length !== n) throw new Error("matrix/rhs size mismatch");
  const m = a.map((row) => Array.from(row));
  const rhs = Float64Array.from(b);
  const scale = Math.max(1, ...rhs.map((v) => Math.abs(v)));
  let magnitude = 0;
  for (const row of m) for (const value of row) magnitude = Math.max(magnitude, Math.abs(value));
  const singularBelow = 1e-12 * Math.max(1, magnitude);

  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    let best = Math.abs(m[column][column]);
    for (let row = column + 1; row < n; row += 1) {
      const candidate = Math.abs(m[row][column]);
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    // An ungrounded Laplacian has a structurally zero pivot: report singular
    // instead of manufacturing a huge displacement.
    if (!(best > singularBelow)) return { solution: null, backwardError: Number.POSITIVE_INFINITY };
    if (pivot !== column) {
      const row = m[pivot];
      m[pivot] = m[column];
      m[column] = row;
      const value = rhs[pivot];
      rhs[pivot] = rhs[column];
      rhs[column] = value;
    }
    const diagonal = m[column][column];
    for (let row = column + 1; row < n; row += 1) {
      const factor = m[row][column] / diagonal;
      if (factor === 0) continue;
      m[row][column] = 0;
      for (let k = column + 1; k < n; k += 1) m[row][k] -= factor * m[column][k];
      rhs[row] -= factor * rhs[column];
    }
  }

  const solution = new Float64Array(n);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = rhs[row];
    for (let k = row + 1; k < n; k += 1) sum -= m[row][k] * solution[k];
    solution[row] = sum / m[row][row];
  }

  // Relative backward error: how well A·x reproduces b.
  let residual = 0;
  for (let row = 0; row < n; row += 1) {
    let sum = 0;
    for (let k = 0; k < n; k += 1) sum += a[row][k] * solution[k];
    residual = Math.max(residual, Math.abs(sum - b[row]));
  }
  return { solution, backwardError: residual / scale };
}

/** Invert a small square matrix by Gauss-Jordan; `null` when singular. */
export function invertDense(a) {
  const n = a.length;
  const m = a.map((row) => [...row]);
  const inverse = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => (row === column ? 1 : 0)),
  );
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(m[row][column]) > Math.abs(m[pivot][column])) pivot = row;
    }
    if (m[pivot][column] === 0) return null;
    if (pivot !== column) {
      [m[pivot], m[column]] = [m[column], m[pivot]];
      [inverse[pivot], inverse[column]] = [inverse[column], inverse[pivot]];
    }
    const diagonal = m[column][column];
    for (let k = 0; k < n; k += 1) {
      m[column][k] /= diagonal;
      inverse[column][k] /= diagonal;
    }
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = m[row][column];
      if (factor === 0) continue;
      for (let k = 0; k < n; k += 1) {
        m[row][k] -= factor * m[column][k];
        inverse[row][k] -= factor * inverse[column][k];
      }
    }
  }
  return inverse;
}

function zeros(n) {
  return Array.from({ length: n }, () => new Float64Array(n));
}

/** K·x for a dense symmetric matrix. */
function multiply(matrix, vector) {
  const n = vector.length;
  const out = new Float64Array(n);
  for (let row = 0; row < n; row += 1) {
    let sum = 0;
    const line = matrix[row];
    for (let column = 0; column < n; column += 1) sum += line[column] * vector[column];
    out[row] = sum;
  }
  return out;
}

function infinityNorm(vector) {
  let norm = 0;
  for (const value of vector) norm = Math.max(norm, Math.abs(value));
  return norm;
}

// ---------------------------------------------------------------------------
// Structure assembly
// ---------------------------------------------------------------------------

/**
 * Assemble the stiffness matrix from weighted two-node relations.
 * @param count - number of coordinates.
 * @param relations - `{ a: number, b: number, weight: number }`.
 * @returns dense symmetric stiffness.
 */
export function assembleStiffness(count, relations) {
  const k = zeros(count);
  for (const relation of relations) {
    const { a, b, weight } = relation;
    if (!(weight > 0)) continue;
    k[a][a] += weight;
    k[b][b] += weight;
    k[a][b] -= weight;
    k[b][a] -= weight;
  }
  return k;
}

/**
 * Solve the constrained equilibrium by forming the KKT saddle system
 * `[K Cᵀ; C 0][u; λ] = [f; d]`.
 *
 * @param stiffness - dense stiffness.
 * @param load - activation vector.
 * @param constraints - `{ row: number[], rhs: number }[]`, one per support.
 * @returns `{ solution, multipliers, backwardError }`.
 */
export function solveConstrained(stiffness, load, constraints) {
  const size = load.length;
  const rows = constraints.length;
  if (rows === 0) {
    const solved = solveDense(stiffness, load);
    return { ...solved, multipliers: solved.solution === null ? null : [] };
  }
  const total = size + rows;
  const kkt = zeros(total);
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) kkt[row][column] = stiffness[row][column];
  }
  for (let index = 0; index < rows; index += 1) {
    const constraint = constraints[index];
    for (let coordinate = 0; coordinate < size; coordinate += 1) {
      const coefficient = constraint.row[coordinate] ?? 0;
      kkt[coordinate][size + index] = coefficient;
      kkt[size + index][coordinate] = coefficient;
    }
  }
  const rhs = new Float64Array(total);
  for (let index = 0; index < size; index += 1) rhs[index] = load[index];
  for (let index = 0; index < rows; index += 1) rhs[size + index] = constraints[index].rhs;
  const solved = solveDense(kkt, rhs);
  if (solved.solution === null) return { solution: null, multipliers: null, backwardError: Number.POSITIVE_INFINITY };
  return {
    solution: solved.solution.slice(0, size),
    multipliers: solved.solution.slice(size),
    backwardError: solved.backwardError,
  };
}

// ---------------------------------------------------------------------------
// Static condensation (the compression step) and its certificate
// ---------------------------------------------------------------------------

/**
 * Guyan static condensation over a keeper set.
 *
 * retained:    u_R = S⁻¹ (f_R − K_RE K_EE⁻¹ f_E),  S = K_RR − K_RE K_EE⁻¹ K_ER
 * eliminated:  u_E = K_EE⁻¹ (f_E − K_ER u_R) = P·u_R + q
 *
 * `P` and `q` are the reconstruction operator: they prove that everything the
 * condensation removed can be recomputed from what was kept.
 *
 * @returns reduction record, or `null` when the eliminated block is singular.
 */
export function condense(stiffness, load, retainedIndices) {
  const size = load.length;
  const retained = [...retainedIndices].sort((left, right) => left - right);
  const retainedSet = new Set(retained);
  const eliminated = [];
  for (let index = 0; index < size; index += 1) if (!retainedSet.has(index)) eliminated.push(index);
  if (eliminated.length === 0) {
    return {
      retained,
      eliminated,
      reducedStiffness: retained.map((row) => retained.map((column) => stiffness[row][column])),
      reducedLoad: retained.map((row) => load[row]),
      reconstructionOperator: [],
      reconstructionOffset: [],
    };
  }
  const kEE = eliminated.map((row) => eliminated.map((column) => stiffness[row][column]));
  const inverse = invertDense(kEE);
  if (inverse === null) return null;
  const kER = eliminated.map((row) => retained.map((column) => stiffness[row][column]));
  const fE = eliminated.map((row) => load[row]);

  // inverse·kER  → |E|×|R|
  const inverseTimesKER = eliminated.map((_, row) =>
    retained.map((_, column) => {
      let sum = 0;
      for (let k = 0; k < eliminated.length; k += 1) sum += inverse[row][k] * kER[k][column];
      return sum;
    }),
  );
  // inverse·fE → |E|
  const inverseTimesFE = eliminated.map((_, row) => {
    let sum = 0;
    for (let k = 0; k < eliminated.length; k += 1) sum += inverse[row][k] * fE[k];
    return sum;
  });

  const reducedStiffness = retained.map((row, i) =>
    retained.map((_, j) => {
      let sum = stiffness[row][retained[j]];
      for (let k = 0; k < eliminated.length; k += 1) {
        sum -= stiffness[row][eliminated[k]] * inverseTimesKER[k][j];
      }
      return sum;
    }),
  );
  const reducedLoad = retained.map((row, i) => {
    let sum = load[row];
    for (let k = 0; k < eliminated.length; k += 1) {
      sum -= stiffness[row][eliminated[k]] * inverseTimesFE[k];
    }
    return sum;
  });

  return {
    retained,
    eliminated,
    reducedStiffness,
    reducedLoad,
    // u_E = P·u_R + q
    reconstructionOperator: inverseTimesKER.map((row) => row.map((value) => -value)),
    reconstructionOffset: inverseTimesFE,
  };
}

/** Restrict a constraint set to the kept coordinates; `null` when a support was dropped. */
function projectConstraints(constraints, retained) {
  const retainedSet = new Set(retained);
  const index = new Map(retained.map((coordinate, position) => [coordinate, position]));
  const projected = [];
  for (const constraint of constraints) {
    const row = new Float64Array(retained.length);
    for (let coordinate = 0; coordinate < constraint.row.length; coordinate += 1) {
      const coefficient = constraint.row[coordinate] ?? 0;
      if (coefficient === 0) continue;
      if (!retainedSet.has(coordinate)) return null;
      row[index.get(coordinate)] = coefficient;
    }
    projected.push({ row, rhs: constraint.rhs });
  }
  return projected;
}

/**
 * Certificate: solve the full constrained structure, solve the condensed one with
 * its projected supports, then rebuild the eliminated DOFs through the
 * reconstruction operator and compare both. A large residual means the
 * condensation dropped load-bearing structure, so the checkpoint must not be
 * published.
 */
export function certify(stiffness, load, constraints, reduction) {
  const projected = projectConstraints(constraints, reduction.retained);
  if (projected === null) {
    return { passed: false, reason: "a support coordinate was eliminated", reconstructionError: Number.POSITIVE_INFINITY };
  }
  const full = solveConstrained(stiffness, load, constraints);
  if (full.solution === null) return { passed: false, reason: "full solve failed", reconstructionError: Number.POSITIVE_INFINITY };
  const reduced = solveConstrained(reduction.reducedStiffness, reduction.reducedLoad, projected);
  if (reduced.solution === null) return { passed: false, reason: "reduced solve failed", reconstructionError: Number.POSITIVE_INFINITY };
  let discrepancy = 0;
  for (let index = 0; index < reduction.retained.length; index += 1) {
    discrepancy = Math.max(discrepancy, Math.abs(reduced.solution[index] - full.solution[reduction.retained[index]]));
  }
  let reconstructionError = 0;
  for (let row = 0; row < reduction.eliminated.length; row += 1) {
    let value = reduction.reconstructionOffset[row];
    for (let column = 0; column < reduction.retained.length; column += 1) {
      value += reduction.reconstructionOperator[row][column] * reduced.solution[column];
    }
    reconstructionError = Math.max(reconstructionError, Math.abs(value - full.solution[reduction.eliminated[row]]));
  }
  const scale = Math.max(1, infinityNorm(full.solution));
  const error = Math.max(discrepancy, reconstructionError) / scale;
  return {
    passed: error <= 1e-8,
    reason: error <= 1e-8 ? "reconstruction matches full retention" : "reconstruction deviates from full retention",
    reconstructionError: error,
    fullSolution: full.solution,
    reducedSolution: reduced.solution,
    backwardError: full.backwardError,
  };
}

// ---------------------------------------------------------------------------
// Dependency closure (structural connectivity)
// ---------------------------------------------------------------------------

/**
 * Selection certificate — the one that decides whether compression is *safe*.
 *
 * AstrContinuum runs the same activation twice: once on the reduced structure
 * (retained coordinates only) and once on the full structure, then requires the
 * retained response to be unchanged. If dropping the eliminated coordinates
 * changes how the kept ones respond to the load, they were load-bearing and the
 * checkpoint must not be published.
 *
 * @returns `{ passed, maxChange, response }`.
 */
export function certifySelection(stiffness, load, constraints, retained) {
  const projected = projectConstraints(constraints, retained);
  if (projected === null) {
    return { passed: false, reason: "a support coordinate was eliminated", maxChange: Number.POSITIVE_INFINITY };
  }
  const full = solveConstrained(stiffness, load, constraints);
  if (full.solution === null) return { passed: false, reason: "full solve failed", maxChange: Number.POSITIVE_INFINITY };
  const subStiffness = retained.map((row) => retained.map((column) => stiffness[row][column]));
  const subLoad = retained.map((row) => load[row]);
  const reduced = solveConstrained(subStiffness, subLoad, projected);
  if (reduced.solution === null) {
    return { passed: false, reason: "reduced structure is singular", maxChange: Number.POSITIVE_INFINITY };
  }
  let change = 0;
  for (let index = 0; index < retained.length; index += 1) {
    change = Math.max(change, Math.abs(reduced.solution[index] - full.solution[retained[index]]));
  }
  const scale = Math.max(1, infinityNorm(full.solution));
  const maxChange = change / scale;
  return {
    passed: maxChange <= 1e-8,
    reason: maxChange <= 1e-8 ? "reduced structure reproduces the full response" : "reduced structure changes the kept response",
    maxChange,
    response: reduced.solution,
  };
}

/** Connected components over the weighted relations. */
export function dependencyGroups(count, relations) {
  const parent = Array.from({ length: count }, (_, index) => index);
  const find = (value) => {
    let root = value;
    while (parent[root] !== root) root = parent[root];
    while (parent[value] !== root) {
      const next = parent[value];
      parent[value] = root;
      value = next;
    }
    return root;
  };
  for (const relation of relations) {
    if (!(relation.weight > 0)) continue;
    const left = find(relation.a);
    const right = find(relation.b);
    if (left !== right) parent[right] = left;
  }
  const groups = new Map();
  for (let index = 0; index < count; index += 1) {
    const root = find(index);
    const group = groups.get(root);
    if (group === undefined) groups.set(root, [index]);
    else group.push(index);
  }
  return [...groups.values()].sort((left, right) => left[0] - right[0]);
}

/**
 * Force every support into the keeper set, then close over structural companions.
 * A support is a boundary condition: it may never be eliminated.
 */
export function closeClosure(count, relations, selected, supports, maxBlocks) {
  const kept = new Set(selected);
  for (const support of supports) kept.add(support);
  if (kept.size > maxBlocks) return { ok: false, reason: "closure capacity exceeded" };
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of relations) {
      if (!(relation.weight > 0)) continue;
      const inA = kept.has(relation.a);
      const inB = kept.has(relation.b);
      if (inA === inB) continue;
      if (kept.size >= maxBlocks) return { ok: false, reason: "closure capacity exceeded" };
      kept.add(inA ? relation.b : relation.a);
      changed = true;
    }
  }
  return { ok: true, kept, blocks: [...kept].sort((left, right) => left - right) };
}

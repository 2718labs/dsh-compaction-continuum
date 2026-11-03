/**
 * Structural core self-test. Requires no Harness install and no dependencies:
 *   node test/structure.test.mjs
 */
import {
  assembleStiffness,
  solveConstrained,
  condense,
  certify,
  certifySelection,
  closeClosure,
  dependencyGroups,
} from "../lib/structure/core.js";

let failures = 0;
function check(name, actual, expected, tolerance = 1e-9) {
  const ok =
    typeof expected === "number" && typeof actual === "number"
      ? Math.abs(actual - expected) <= tolerance
      : JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `\n      expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}
function checkTrue(name, value) {
  console.log(`${value ? "PASS" : "FAIL"}  ${name}`);
  if (!value) failures += 1;
}

// 3-DOF chain: 0 —— 1 —— 2, unit stiffness, load 1 at node 2, node 0 fixed.
const relations = [
  { a: 0, b: 1, weight: 1 },
  { a: 1, b: 2, weight: 1 },
];
const stiffness = assembleStiffness(3, relations);
const load = [0, 0, 1];
const supports = [{ row: [1, 0, 0], rhs: 0 }];

const full = solveConstrained(stiffness, load, supports);
// Equilibrium: 2u1 - u2 = 0, -u1 + u2 = 1  ->  u1 = 1, u2 = 2, u0 = 0.
check("equilibrium u0", full.solution[0], 0, 1e-8);
check("equilibrium u1", full.solution[1], 1, 1e-8);
check("equilibrium u2", full.solution[2], 2, 1e-8);

// Static condensation keeping everything is the identity.
const all = condense(stiffness, load, [0, 1, 2]);
checkTrue("condense(all) has no eliminated DOFs", all.eliminated.length === 0);

// Condense keeping only the support; reconstruction must reproduce the full field.
const reduction = condense(stiffness, load, [0]);
const certificate = certify(stiffness, load, supports, reduction);
checkTrue(`reconstruction certificate passes (error ${certificate.reconstructionError?.toExponential(2)})`, certificate.passed);

// Selection certificate: severing the load path must be rejected.
const severed = certifySelection(stiffness, load, supports, [0, 2]);
checkTrue(`selection of a severed structure is rejected (${severed.reason})`, severed.passed === false);
const whole = certifySelection(stiffness, load, supports, [0, 1, 2]);
checkTrue("selection of the whole structure is accepted", whole.passed === true);

// A support that is eliminated is a hard failure.
const droppedSupport = certifySelection(stiffness, load, supports, [1, 2]);
checkTrue("eliminating a support is rejected", droppedSupport.passed === false);

// Singular structure (no support) must not silently pass.
const ungrounded = solveConstrained(stiffness, load, []);
checkTrue("ungrounded structure is reported singular or unstable", ungrounded.solution === null || ungrounded.backwardError > 1e-8);

// Dependency closure over the same chain.
const closure = closeClosure(3, relations, [2], [0], 10);
check("closure from {2} + support {0} reaches the whole chain", closure.blocks, [0, 1, 2]);
const capped = closeClosure(3, relations, [2], [0], 2);
checkTrue("closure respects the block cap", capped.ok === false);
check("connected components", dependencyGroups(3, [{ a: 0, b: 1, weight: 1 }]), [
  [0, 1],
  [2],
]);

console.log(failures === 0 ? "\nALL STRUCTURAL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;

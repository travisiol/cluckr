import * as THREE from "three";
import { ceramic, chrome, ivory, roast } from "@/lib/three/studio";

/*
  The props on the table, built from primitives: a cloche (lathe dome with
  a lip and a knob), the plate under it, a roast chicken and a bone.
  Geometries are shared; materials are per prop where they animate.
*/

export const CLOCHE_R = 0.52;
export const CLOCHE_H = 0.62;

let clocheGeometry: THREE.LatheGeometry | null = null;
export function clocheShape(): THREE.LatheGeometry {
  if (clocheGeometry) return clocheGeometry;
  const points: THREE.Vector2[] = [];
  // Lip: a small rolled rim at the bottom.
  points.push(new THREE.Vector2(CLOCHE_R - 0.02, 0));
  points.push(new THREE.Vector2(CLOCHE_R + 0.03, 0.015));
  points.push(new THREE.Vector2(CLOCHE_R + 0.035, 0.045));
  points.push(new THREE.Vector2(CLOCHE_R, 0.075));
  // Dome: a quarter ellipse, slightly fuller than a hemisphere.
  const steps = 26;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    const r = CLOCHE_R * Math.cos(t) * (1 + 0.06 * Math.sin(t));
    const y = 0.075 + (CLOCHE_H - 0.075) * Math.sin(t);
    points.push(new THREE.Vector2(Math.max(r, 0.001), y));
  }
  points.push(new THREE.Vector2(0.0005, CLOCHE_H));
  clocheGeometry = new THREE.LatheGeometry(points, 72);
  return clocheGeometry;
}

let knobGeometry: THREE.SphereGeometry | null = null;
let stemGeometry: THREE.CylinderGeometry | null = null;

/** A cloche with its own chrome so opacity and tint can animate per cell. */
export function makeCloche(): { group: THREE.Group; material: THREE.MeshPhysicalMaterial; dome: THREE.Mesh } {
  const material = chrome();
  const group = new THREE.Group();
  const dome = new THREE.Mesh(clocheShape(), material);
  dome.castShadow = false;
  group.add(dome);
  knobGeometry ??= new THREE.SphereGeometry(0.075, 24, 18);
  stemGeometry ??= new THREE.CylinderGeometry(0.03, 0.045, 0.07, 16);
  const stem = new THREE.Mesh(stemGeometry, material);
  stem.position.y = CLOCHE_H + 0.03;
  group.add(stem);
  const knob = new THREE.Mesh(knobGeometry, material);
  knob.position.y = CLOCHE_H + 0.11;
  group.add(knob);
  return { group, material, dome };
}

let plateGeometry: THREE.CylinderGeometry | null = null;
let plateMaterial: THREE.MeshPhysicalMaterial | null = null;
export function makePlate(): THREE.Mesh {
  plateGeometry ??= new THREE.CylinderGeometry(0.62, 0.56, 0.05, 56);
  plateMaterial ??= ceramic();
  const plate = new THREE.Mesh(plateGeometry, plateMaterial);
  plate.position.y = 0.025;
  return plate;
}

let bodyGeometry: THREE.SphereGeometry | null = null;
let legGeometry: THREE.CapsuleGeometry | null = null;
let tipGeometry: THREE.SphereGeometry | null = null;
let wingGeometry: THREE.SphereGeometry | null = null;

/** A glazed roast: a plump body, two drumsticks tipped with bone, two wing bumps. */
export function makeChicken(): THREE.Group {
  const group = new THREE.Group();
  const glaze = roast();
  bodyGeometry ??= new THREE.SphereGeometry(0.3, 36, 26);
  legGeometry ??= new THREE.CapsuleGeometry(0.075, 0.2, 8, 16);
  tipGeometry ??= new THREE.SphereGeometry(0.05, 16, 12);
  wingGeometry ??= new THREE.SphereGeometry(0.12, 20, 14);

  const body = new THREE.Mesh(bodyGeometry, glaze);
  body.scale.set(1.15, 0.8, 1.0);
  body.position.y = 0.29;
  group.add(body);

  const breast = new THREE.Mesh(bodyGeometry, glaze);
  breast.scale.set(0.62, 0.5, 0.62);
  breast.position.set(0, 0.36, 0.1);
  group.add(breast);

  for (const side of [-1, 1]) {
    const leg = new THREE.Mesh(legGeometry, glaze);
    leg.position.set(side * 0.23, 0.26, -0.2);
    leg.rotation.set(-0.9, 0, side * 0.55);
    group.add(leg);
    const tip = new THREE.Mesh(tipGeometry, ivory());
    tip.position.set(side * 0.31, 0.32, -0.37);
    group.add(tip);
    const wing = new THREE.Mesh(wingGeometry, glaze);
    wing.scale.set(0.9, 0.55, 1.2);
    wing.position.set(side * 0.31, 0.33, 0.02);
    group.add(wing);
  }
  return group;
}

let shaftGeometry: THREE.CapsuleGeometry | null = null;
let knuckleGeometry: THREE.SphereGeometry | null = null;

/** A bone lying on the plate. The ivory carries the red flash. */
export function makeBone(): { group: THREE.Group; material: THREE.MeshPhysicalMaterial } {
  const group = new THREE.Group();
  const material = ivory();
  shaftGeometry ??= new THREE.CapsuleGeometry(0.06, 0.42, 8, 16);
  knuckleGeometry ??= new THREE.SphereGeometry(0.085, 20, 14);
  const shaft = new THREE.Mesh(shaftGeometry, material);
  shaft.rotation.z = Math.PI / 2;
  shaft.position.y = 0.12;
  group.add(shaft);
  for (const side of [-1, 1]) {
    for (const off of [-1, 1]) {
      const knuckle = new THREE.Mesh(knuckleGeometry, material);
      knuckle.position.set(side * 0.26, 0.12 + off * 0.02, off * 0.07);
      group.add(knuckle);
    }
  }
  group.rotation.y = 0.5;
  return { group, material };
}

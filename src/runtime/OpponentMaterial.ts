import * as THREE from 'three';

export interface OpponentTextures {
  subject: THREE.Texture;
  background: THREE.Texture;
  frame: THREE.Texture;
}

interface OpponentMaterialOptions {
  subjectDepth?: number;
  backgroundDepth?: number;
  foil?: number;
  /** The exported hero-card GLB uses a vertically inverted UV basis; planes do not. */
  flipY?: boolean;
}

const vertex = /* glsl */ `
varying vec2 vUv;
uniform float uFlipY;
void main() {
  vUv = vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlipY));
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragment = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSubject, tBackground, tFrame;
uniform vec3 uView, uTint;
uniform float uDepth, uBgDepth, uFoil, uOpacity;

float inside(vec2 p) {
  return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
}
vec2 parallax(vec2 uv, float depth) {
  // Same signed-depth convention as CardFactory, in the card's own axes.
  return uv + uView.xy / max(abs(uView.z), .35) * depth * .14;
}
void main() {
  vec2 subjectUv = parallax(vUv, uDepth);
  vec2 backgroundUv = parallax(vUv, uBgDepth);
  vec4 subject = texture2D(tSubject, clamp(subjectUv, 0.0, 1.0));
  subject.a *= inside(subjectUv);
  vec3 background = texture2D(tBackground, clamp(backgroundUv, 0.0, 1.0)).rgb;
  vec3 color = mix(background, subject.rgb, subject.a);

  // Small view-dependent laminate. No time-driven rainbow or bright edge band.
  float phase = vUv.x * .72 + vUv.y * .45 + uView.x * 1.2 + uView.y * .6;
  float band = pow(.5 + .5 * sin(phase * 6.28318), 10.0);
  vec3 foil = .75 + .18 * cos(6.28318 * (phase + vec3(0.0, .33, .67)));
  color *= 1.0 - uFoil * .12 * (1.0 - foil) * band;
  color += foil * uFoil * band * .065;

  // Frame UVs never move. Its asset already contains the requested 32% alpha.
  vec4 frame = texture2D(tFrame, vUv);
  color = mix(color, frame.rgb, frame.a) * uTint;
  // Art is sampled as sRGB data, matching CardFactory's explicit conversion.
  gl_FragColor = vec4(pow(clamp(color, 0.0, 1.0), vec3(2.2)), uOpacity);
  #include <colorspace_fragment>
}
`;

/** Each card owns uniforms; only immutable layer textures are shared. */
export function createOpponentMaterial(textures: OpponentTextures, options: OpponentMaterialOptions = {}) {
  for (const texture of Object.values(textures)) {
    texture.colorSpace = THREE.NoColorSpace;
    texture.anisotropy = 4;
  }
  const uniforms = {
    tSubject: { value: textures.subject },
    tBackground: { value: textures.background },
    tFrame: { value: textures.frame },
    uView: { value: new THREE.Vector3(0, 0, 1) },
    uDepth: { value: options.subjectDepth ?? .28 },
    uBgDepth: { value: options.backgroundDepth ?? -.18 },
    uFoil: { value: options.foil ?? .16 },
    uFlipY: { value: options.flipY ? 1 : 0 },
    uTint: { value: new THREE.Color(1, 1, 1) },
    uOpacity: { value: 1 },
  };
  return Object.assign(new THREE.ShaderMaterial({
    uniforms, vertexShader: vertex, fragmentShader: fragment,
    toneMapped: false, side: THREE.FrontSide,
  }), { uniforms });
}

export type OpponentMaterial = ReturnType<typeof createOpponentMaterial>;

/** Use the canonical card root for GLB meshes whose mesh axes differ from the art. */
export function bindOpponentView(mesh: THREE.Mesh<THREE.BufferGeometry, OpponentMaterial>,
  cardAxes: THREE.Object3D = mesh): void {
  const inverse = new THREE.Matrix4();
  mesh.onBeforeRender = (_renderer, _scene, camera) => {
    const view = mesh.material.uniforms.uView.value;
    inverse.copy(cardAxes.matrixWorld).invert();
    if (camera instanceof THREE.OrthographicCamera) {
      camera.getWorldDirection(view).negate().transformDirection(inverse);
    } else {
      camera.getWorldPosition(view).applyMatrix4(inverse).normalize();
    }
  };
}

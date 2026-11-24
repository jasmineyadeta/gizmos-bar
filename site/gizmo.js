// Cartoon Gizmo shaking a cocktail shaker. Pure SVG + CSS animation.
export const GIZMO_SVG = `
<svg class="gizmo" viewBox="0 0 280 320" role="img" aria-label="Gizmo shaking a cocktail">
  <defs>
    <linearGradient id="gz-steel" x1="0" x2="1">
      <stop offset="0" stop-color="#8d949c"/><stop offset=".35" stop-color="#f4f6f8"/>
      <stop offset=".6" stop-color="#c3c8ce"/><stop offset="1" stop-color="#7c838b"/>
    </linearGradient>
    <linearGradient id="gz-steel-v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f4f6f8"/><stop offset=".45" stop-color="#c3c8ce"/><stop offset="1" stop-color="#7c838b"/>
    </linearGradient>
    <linearGradient id="gz-skin" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#f6cfae"/><stop offset="1" stop-color="#e9b08c"/>
    </linearGradient>
  </defs>

  <!-- shirt, suspenders, bow tie -->
  <path d="M40 320 C42 250 66 214 120 210 C174 214 198 250 200 320 Z" fill="#a9afb6"/>
  <path d="M102 212 L120 236 L138 212 Z" fill="#c5cacf"/>
  <path d="M74 220 L86 320 L100 320 L90 216 Z" fill="#1c1c1f"/>
  <path d="M166 220 L154 320 L140 320 L150 216 Z" fill="#1c1c1f"/>
  <rect x="108" y="184" width="24" height="30" rx="6" fill="#e9b08c"/>
  <g transform="translate(0 12)">
    <path d="M120 206 L98 194 Q94 206 98 218 Z" fill="#141416"/>
    <path d="M120 206 L142 194 Q146 206 142 218 Z" fill="#141416"/>
    <rect x="114" y="200" width="12" height="12" rx="3" fill="#000"/>
  </g>

  <!-- head -->
  <g class="gz-head">
    <ellipse cx="120" cy="112" rx="52" ry="62" fill="url(#gz-skin)"/>
    <ellipse cx="104" cy="70" rx="20" ry="10" fill="#fff" opacity=".35" transform="rotate(-18 104 70)"/>
    <!-- white hair around the sides -->
    <path d="M74 88 Q58 104 62 140 Q66 152 76 150 Q70 132 73 114 Q75 100 80 92 Z" fill="#f1f1ee"/>
    <path d="M166 88 Q182 104 178 140 Q174 152 164 150 Q170 132 167 114 Q165 100 160 92 Z" fill="#f1f1ee"/>
    <path d="M66 112 l-5 -3 M64 126 l-5 0 M174 112 l5 -3 M176 126 l5 0" stroke="#f1f1ee" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="66" cy="122" rx="10" ry="15" fill="#eab48f"/>
    <ellipse cx="174" cy="122" rx="10" ry="15" fill="#eab48f"/>
    <!-- forehead lines -->
    <path d="M100 78 Q120 72 140 78 M104 86 Q120 81 136 86" stroke="#d99a76" stroke-width="2" fill="none" stroke-linecap="round"/>
    <!-- eyebrows -->
    <path d="M86 98 Q99 90 112 98" stroke="#3a2a22" stroke-width="5" fill="none" stroke-linecap="round"/>
    <path d="M128 98 Q141 90 154 98" stroke="#3a2a22" stroke-width="5" fill="none" stroke-linecap="round"/>
    <!-- round thin-frame glasses -->
    <path d="M84 113 L70 112 M156 113 L170 112" stroke="#b9bcc0" stroke-width="2"/>
    <circle cx="100" cy="116" r="16" fill="#2a211e" stroke="#c9ccd0" stroke-width="2.4"/>
    <circle cx="140" cy="116" r="16" fill="#2a211e" stroke="#c9ccd0" stroke-width="2.4"/>
    <path d="M116 114 Q120 110 124 114" stroke="#c9ccd0" stroke-width="2.4" fill="none"/>
    <path d="M92 109 Q96 105 101 106" stroke="#fff" stroke-width="2.2" fill="none" opacity=".45" stroke-linecap="round"/>
    <path d="M132 109 Q136 105 141 106" stroke="#fff" stroke-width="2.2" fill="none" opacity=".45" stroke-linecap="round"/>
    <!-- nose -->
    <path d="M118 124 Q112 140 116 144 Q122 148 128 143" fill="#e3a580" stroke="#cf8f6b" stroke-width="1.5"/>
    <!-- beard -->
    <path d="M74 132 Q74 186 120 192 Q166 186 166 132 Q160 160 140 158 Q120 152 100 158 Q80 160 74 132 Z" fill="#ecebe6"/>
    <path d="M74 132 Q74 186 120 192 Q166 186 166 132" fill="none" stroke="#d6d4cc" stroke-width="2"/>
    <path d="M96 150 Q120 140 144 150 Q132 156 120 153 Q108 156 96 150 Z" fill="#dcdad3"/>
    <!-- big smile -->
    <path d="M97 155 Q120 184 143 155 Q120 163 97 155 Z" fill="#7a2e2a"/>
    <path d="M101 157 Q120 163 139 157 L137 162 Q120 167 103 162 Z" fill="#fff"/>
  </g>

  <!-- both hands on the shaker, tilted up by his shoulder -->
  <g class="gz-arm">
    <path d="M72 236 C82 272 134 270 184 214" stroke="#8a9097" stroke-width="26" fill="none" stroke-linecap="round"/>
    <path d="M72 236 C82 272 134 270 184 214" stroke="#a9afb6" stroke-width="22" fill="none" stroke-linecap="round"/>
    <path d="M172 234 Q236 244 226 176" stroke="#8a9097" stroke-width="26" fill="none" stroke-linecap="round"/>
    <path d="M172 234 Q236 244 226 176" stroke="#a9afb6" stroke-width="22" fill="none" stroke-linecap="round"/>
    <g class="gz-shaker">
      <g transform="translate(206 190) rotate(-38)">
        <path d="M-36 -12 L10 -16 L10 16 L-36 12 Z" fill="url(#gz-steel-v)" stroke="#6c737a" stroke-width="1.5"/>
        <path d="M10 -16 L24 -11 L24 11 L10 16 Z" fill="url(#gz-steel-v)" stroke="#6c737a" stroke-width="1.5"/>
        <rect x="24" y="-6" width="9" height="12" rx="3" fill="url(#gz-steel-v)" stroke="#6c737a" stroke-width="1.5"/>
        <path d="M-32 -8 L6 -11" stroke="#fff" stroke-width="3" opacity=".65" stroke-linecap="round"/>
      </g>
      <circle cx="186" cy="210" r="11" fill="#eab48f" stroke="#cf8f6b" stroke-width="1.5"/>
      <circle cx="226" cy="172" r="11" fill="#eab48f" stroke="#cf8f6b" stroke-width="1.5"/>
    </g>
  </g>

  <!-- shake lines -->
  <g class="gz-lines" stroke="#f5b041" stroke-width="3" stroke-linecap="round" fill="none">
    <path d="M256 140 Q266 156 260 174"/>
    <path d="M178 152 Q170 168 176 186"/>
  </g>
</svg>`;

let loaderEl;
export function showLoader(text = "Gizmo's mixing...") {
  if (!loaderEl) {
    loaderEl = document.createElement("div");
    loaderEl.className = "loader";
    loaderEl.innerHTML = `${GIZMO_SVG}<p class="loader-text"></p>`;
    document.body.appendChild(loaderEl);
  }
  loaderEl.querySelector(".loader-text").textContent = text;
  loaderEl.classList.add("show");
}
export function hideLoader() {
  loaderEl?.classList.remove("show");
}

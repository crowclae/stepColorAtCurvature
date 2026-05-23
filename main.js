////////////////////////////////////////////////////////////
// main.js  –  STEP Face Viewer (FaceID Mode)
//
//  - opencascade.js (WASM) で STEP を読み込み
//  - TopExp_Explorer でフェイスを列挙 → 各頂点に faceId を付与
//  - インデックス付き BufferGeometry で頂点を共有
//  - tris.Normal(v) による解析的頂点法線（円柱・球が滑らか）
//  - REVERSED フェイスは巻き順を反転して法線方向を統一
//  - BFS なし：faceGroupMap の完全一致で塗りつぶし
//  - coi-serviceworker.js が COOP/COEP ヘッダを注入
////////////////////////////////////////////////////////////


////////////////////////////////////////////////////////////
// Imports
////////////////////////////////////////////////////////////

import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.165.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.165.0/examples/jsm/controls/OrbitControls.js';


////////////////////////////////////////////////////////////
// HTML Elements
////////////////////////////////////////////////////////////

const canvas            = document.getElementById('viewer');
const stepFileInput     = document.getElementById('stepFile');
const colorPicker       = document.getElementById('colorPicker');
const loading           = document.getElementById('loading');
const faceIdLabel       = document.getElementById('faceId');
const meshNameLabel     = document.getElementById('meshName');
const triCountLabel     = document.getElementById('triCount');
const viewerContainer   = document.getElementById('viewer-container');
const undoButton        = document.getElementById('undoButton');
const saveColorsButton  = document.getElementById('saveColorsButton');
const importColorsFile  = document.getElementById('importColorsFile');


////////////////////////////////////////////////////////////
// Scene
////////////////////////////////////////////////////////////

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1e1e);


////////////////////////////////////////////////////////////
// Camera
////////////////////////////////////////////////////////////

const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100000
);
camera.position.set(150, 120, 150);


////////////////////////////////////////////////////////////
// Renderer
////////////////////////////////////////////////////////////

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);


////////////////////////////////////////////////////////////
// Controls
////////////////////////////////////////////////////////////

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;


////////////////////////////////////////////////////////////
// Lights
////////////////////////////////////////////////////////////

scene.add(new THREE.AmbientLight(0xffffff, 1.4));

const dirLight = new THREE.DirectionalLight(0xffffff, 2.0);
dirLight.position.set(100, 150, 100);
scene.add(dirLight);


////////////////////////////////////////////////////////////
// Grid
////////////////////////////////////////////////////////////

scene.add(new THREE.GridHelper(500, 50, 0x444444, 0x2a2a2a));


////////////////////////////////////////////////////////////
// Raycaster
////////////////////////////////////////////////////////////

const raycaster = new THREE.Raycaster();
const mouse     = new THREE.Vector2();


////////////////////////////////////////////////////////////
// State
////////////////////////////////////////////////////////////

let currentModel    = null;
let faceGroupMap    = null;   // Map<faceId, 三角形インデックス[]>
let faceIdPerVertex = null;   // Float32Array: 頂点インデックス → faceId
let isLeftMouseDown = false;
let isRotating      = false;
let colorHistory    = [];
const MAX_HISTORY   = 20;


////////////////////////////////////////////////////////////
// opencascade.js 初期化
// ES Module ビルドを動的 import() で読み込む
////////////////////////////////////////////////////////////

loading.style.display = 'block';
loading.innerText = 'Loading opencascade.js WASM... (初回のみ約20〜40秒)';

const oc = await import('https://cdn.jsdelivr.net/npm/opencascade.js/dist/opencascade.full.js')
    .then(({ default: OpenCascade }) => OpenCascade({
        locateFile: (path) =>
            `https://cdn.jsdelivr.net/npm/opencascade.js/dist/${path}`
    }));

loading.innerText = 'Drop STEP File';
console.log('OpenCascade.js Ready', oc);


////////////////////////////////////////////////////////////
// STEP ファイル読み込みイベント
////////////////////////////////////////////////////////////

stepFileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (file) await loadStepFile(file);
});

viewerContainer.addEventListener('dragover', (e) => {
    e.preventDefault();
    viewerContainer.classList.add('dragover');
});
viewerContainer.addEventListener('dragleave', () => {
    viewerContainer.classList.remove('dragover');
});
viewerContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    viewerContainer.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file) await loadStepFile(file);
});


////////////////////////////////////////////////////////////
// STEP Loader
////////////////////////////////////////////////////////////

async function loadStepFile(file) {
    try {
        loading.style.display = 'block';
        loading.innerText = 'Reading STEP file...';

        // 旧モデルの破棄
        if (currentModel) {
            scene.remove(currentModel);
            currentModel.traverse((child) => {
                if (child.isMesh) {
                    child.geometry.dispose();
                    child.material.dispose();
                }
            });
            currentModel = null;
        }
        faceGroupMap    = null;
        faceIdPerVertex = null;
        colorHistory    = [];

        // ArrayBuffer → Uint8Array → 仮想 FS
        const fileData = new Uint8Array(await file.arrayBuffer());
        oc.FS.createDataFile('/', 'model.step', fileData, true, true, true);

        // ---- STEP 読み込み ----
        loading.innerText = 'Parsing STEP geometry...';

        const reader     = new oc.STEPControl_Reader_1();
        const readResult = reader.ReadFile('model.step');
        oc.FS.unlink('/model.step');

        if (readResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
            throw new Error('STEP read failed. Status: ' + readResult);
        }

        reader.TransferRoots(new oc.Message_ProgressRange_1());
        const shape = reader.OneShape();

        // ---- メッシュ化 ----
        // 第2引数: 線形偏差、第4引数: 角度偏差[rad]
        loading.innerText = 'Tessellating faces...';
        new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);

        // ---- フェイスごとに頂点・法線・インデックスを収集 ----
        loading.innerText = 'Building FaceID map...';

        const allPositions = [];  // 頂点座標
        const allNormals   = [];  // 解析的頂点法線
        const allIndices   = [];  // 三角形インデックス（インデックス付きジオメトリ用）
        const allFaceIds   = [];  // 頂点ごとの faceId

        const faceGroupTmp = new Map();  // faceId → 三角形インデックス[]

        const explorer = new oc.TopExp_Explorer_1();
        explorer.Init(
            shape,
            oc.TopAbs_ShapeEnum.TopAbs_FACE,
            oc.TopAbs_ShapeEnum.TopAbs_SHAPE
        );

        let faceId       = 0;
        let vertexOffset = 0;  // フェイスごとの頂点オフセット
        let triCounter   = 0;  // グローバル三角形カウンタ

        while (explorer.More()) {
            const face       = oc.TopoDS.Face_1(explorer.Current());
            const location   = new oc.TopLoc_Location_1();

            // BRep_Tool.Triangulation は引数2つ（バージョン依存）
            const polyHandle = oc.BRep_Tool.Triangulation(face, location);

            if (polyHandle.IsNull()) {
                explorer.Next();
                faceId++;
                continue;
            }

            const tris       = polyHandle.get();
            const nNodes     = tris.NbNodes();
            const nTris      = tris.NbTriangles();
            const hasTrsf    = !location.IsIdentity();
            const trsf       = hasTrsf ? location.Transformation() : null;
            const isReversed = face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;
            const sign       = isReversed ? -1 : 1;
            const hasNormals = tris.HasNormals();

            // ---- 頂点座標と解析的法線を収集（1-indexed）----
            for (let v = 1; v <= nNodes; v++) {
                const pnt = tris.Node(v);
                let x = pnt.X(), y = pnt.Y(), z = pnt.Z();

                // ローカル座標 → グローバル座標変換
                if (hasTrsf && trsf) {
                    const tp = pnt.Transformed(trsf);
                    x = tp.X(); y = tp.Y(); z = tp.Z();
                }
                allPositions.push(x, y, z);
                allFaceIds.push(faceId);

                // tris.Normal(v) : BRepMesh が解析曲面から計算した頂点法線
                // 円柱・球・NURBS で頂点ごとに正確な法線が得られる
                if (hasNormals) {
                    const n = tris.Normal(v);
                    allNormals.push(n.X() * sign, n.Y() * sign, n.Z() * sign);
                } else {
                    // フォールバック用のプレースホルダ（後で外積で補完）
                    allNormals.push(0, 1, 0);
                }
            }

            // ---- 三角形インデックスを収集 ----
            const triGroup = [];

            for (let t = 1; t <= nTris; t++) {
                const tri = tris.Triangle(t);
                const i1  = tri.Value(1) - 1 + vertexOffset;
                const i2  = tri.Value(2) - 1 + vertexOffset;
                const i3  = tri.Value(3) - 1 + vertexOffset;

                // REVERSED フェイスは巻き順を反転して裏面を防ぐ
                if (isReversed) {
                    allIndices.push(i1, i3, i2);
                } else {
                    allIndices.push(i1, i2, i3);
                }
                triGroup.push(triCounter++);
            }

            faceGroupTmp.set(faceId, triGroup);
            vertexOffset += nNodes;
            faceId++;
            explorer.Next();
        }

        if (allPositions.length === 0) {
            throw new Error('No triangles found. STEP file may be empty or invalid.');
        }

        // ---- Three.js BufferGeometry（インデックス付き）----
        loading.innerText = 'Building Three.js geometry...';

        const geometry = new THREE.BufferGeometry();

        geometry.setAttribute(
            'position',
            new THREE.Float32BufferAttribute(allPositions, 3)
        );
        geometry.setAttribute(
            'normal',
            new THREE.Float32BufferAttribute(allNormals, 3)
        );

        // faceId を頂点属性として格納（CPU 参照のみ）
        const faceIdArray = new Float32Array(allFaceIds);
        geometry.setAttribute(
            'faceId',
            new THREE.BufferAttribute(faceIdArray, 1)
        );

        // インデックスをセット（頂点共有でスムーズシェーディングが有効になる）
        geometry.setIndex(allIndices);

        // HasNormals() が false だったフェイスの法線を補完
        // （インデックス付きジオメトリなので隣接頂点と補間される）
        const normalAttr = geometry.attributes.normal;
        const hasZeroNormal = allNormals.some((v, i) =>
            i % 3 === 1 && allNormals[i-1] === 0 && v === 1 && allNormals[i+1] === 0
        );
        if (hasZeroNormal) {
            geometry.computeVertexNormals();
        }

        // 頂点カラー（デフォルト：グレー）
        const vertexCount = allPositions.length / 3;
        // 変更後
        const r = 52  / 255;
        const g = 152 / 255;
        const b = 219 / 255;
        const colors = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
            colors[i * 3]     = r;
            colors[i * 3 + 1] = g;
            colors[i * 3 + 2] = b;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

        const material = new THREE.MeshStandardMaterial({
            vertexColors: true,
            metalness:    0.05,
            roughness:    0.65,
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.userData.name = file.name;
        mesh.castShadow    = true;
        mesh.receiveShadow = true;

        currentModel = new THREE.Group();
        currentModel.add(mesh);
        scene.add(currentModel);

        // グローバルマップに昇格
        faceGroupMap    = faceGroupTmp;
        faceIdPerVertex = faceIdArray;

        triCountLabel.innerText = triCounter.toLocaleString();
        fitCameraToObject(currentModel);

        loading.style.display = 'none';
        console.log(`STEP loaded: ${faceId} faces, ${triCounter} triangles`);

    } catch (err) {
        console.error(err);
        loading.innerText = `❌ Load failed: ${err.message}`;
    }
}


////////////////////////////////////////////////////////////
// Paint Core
//
// raycaster で当たった三角形 → インデックス経由で頂点 → faceId 取得
// → faceGroupMap で同 faceId の全三角形を一括塗りつぶし
////////////////////////////////////////////////////////////

function checkAndPaint(clientX, clientY, isFirstClick = false) {
    if (!currentModel || !faceGroupMap) return;

    const rect = canvas.getBoundingClientRect();
    mouse.x =  ((clientX - rect.left) / rect.width)  * 2 - 1;
    mouse.y = -((clientY - rect.top)  / rect.height) * 2 + 1;

    raycaster.setFromCamera(mouse, camera);

    const intersects = raycaster.intersectObjects(currentModel.children, true);
    if (intersects.length === 0) return;

    const intersect   = intersects[0];
    const hitTriangle = intersect.faceIndex;
    if (hitTriangle === undefined) return;

    const geometry   = intersect.object.geometry;
    const indexAttr  = geometry.index;
    const faceIdAttr = geometry.attributes.faceId;

    // インデックス付きジオメトリ：三角形の最初の頂点インデックス経由で faceId を取得
    const vertexIndex = indexAttr.getX(hitTriangle * 3);
    const faceIdVal   = Math.round(faceIdAttr.getX(vertexIndex));

    faceIdLabel.innerText   = faceIdVal;
    meshNameLabel.innerText = `Face_${faceIdVal}`;

    const targetMesh  = intersect.object;
    const sameIdTris  = faceGroupMap.get(faceIdVal) || [];

    if (isFirstClick) saveHistory(targetMesh);
    applyColorToFaceGroup(targetMesh, sameIdTris, colorPicker.value);
}


////////////////////////////////////////////////////////////
// 指定三角形グループに頂点カラーを適用
// インデックス付きジオメトリ対応版
////////////////////////////////////////////////////////////

function applyColorToFaceGroup(mesh, triangleIndices, hexColor) {
    const geometry  = mesh.geometry;
    const colorAttr = geometry.attributes.color;
    const indexAttr = geometry.index;
    if (!colorAttr || !indexAttr) return;

    const color = new THREE.Color(hexColor);

    for (const tIdx of triangleIndices) {
        const v0 = indexAttr.getX(tIdx * 3);
        const v1 = indexAttr.getX(tIdx * 3 + 1);
        const v2 = indexAttr.getX(tIdx * 3 + 2);
        colorAttr.setXYZ(v0, color.r, color.g, color.b);
        colorAttr.setXYZ(v1, color.r, color.g, color.b);
        colorAttr.setXYZ(v2, color.r, color.g, color.b);
    }
    colorAttr.needsUpdate = true;
}


////////////////////////////////////////////////////////////
// Pointer Events
////////////////////////////////////////////////////////////

canvas.addEventListener('pointerdown', (e) => {
    if (e.button === 0 && !e.shiftKey && !e.ctrlKey) {
        isLeftMouseDown = true;
        isRotating      = false;
        checkAndPaint(e.clientX, e.clientY, true);
    } else {
        isRotating = true;
    }
});

canvas.addEventListener('pointermove', (e) => {
    if (isLeftMouseDown && !isRotating) {
        controls.enabled = false;
        checkAndPaint(e.clientX, e.clientY, false);
    }
});

const stopPainting = () => {
    isLeftMouseDown  = false;
    isRotating       = false;
    controls.enabled = true;
};
window.addEventListener('pointerup', stopPainting);
canvas.addEventListener('pointerleave', stopPainting);


////////////////////////////////////////////////////////////
// Palette
////////////////////////////////////////////////////////////

colorPicker.addEventListener('input', (e) => {
    console.log('Brush color:', e.target.value);
});

document.querySelectorAll('.palette-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
        colorPicker.value = e.currentTarget.getAttribute('data-color');
    });
});


////////////////////////////////////////////////////////////
// Undo
////////////////////////////////////////////////////////////

function saveHistory(mesh) {
    const attr = mesh.geometry.attributes.color;
    if (!attr) return;
    colorHistory.push(new Float32Array(attr.array));
    if (colorHistory.length > MAX_HISTORY) colorHistory.shift();
}

undoButton.addEventListener('click', () => {
    if (!colorHistory.length || !currentModel) return;
    const mesh = currentModel.children[0];
    if (!mesh) return;
    const attr = mesh.geometry.attributes.color;
    if (!attr) return;
    attr.array.set(colorHistory.pop());
    attr.needsUpdate = true;
});


////////////////////////////////////////////////////////////
// Save / Load Color JSON
////////////////////////////////////////////////////////////

saveColorsButton.addEventListener('click', () => {
    if (!currentModel) { alert('モデルが読み込まれていません。'); return; }
    const mesh = currentModel.children[0];
    const attr = mesh?.geometry?.attributes?.color;
    if (!attr)  { alert('カラーデータがありません。'); return; }

    const exportData = {
        application:      'STEP Face Viewer – FaceID Mode',
        timestamp:        Date.now(),
        vertexColorCount: attr.array.length,
        colors:           Array.from(attr.array),
    };

    const blob = new Blob([JSON.stringify(exportData)], { type: 'application/json' });
    const a    = Object.assign(document.createElement('a'), {
        href:     URL.createObjectURL(blob),
        download: 'step-colors.json',
    });
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    console.log('Color state saved.');
});

importColorsFile.addEventListener('change', (e) => {
    if (!currentModel) {
        alert('最初に STEP ファイルを読み込んでください。');
        e.target.value = '';
        return;
    }
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
        try {
            const data = JSON.parse(ev.target.result);
            const mesh = currentModel.children[0];
            const attr = mesh?.geometry?.attributes?.color;
            if (!attr) { alert('ジオメトリが無効です。'); return; }
            if (data.vertexColorCount !== attr.array.length) {
                alert('ポリゴン数が異なります。同じ STEP ファイルを使用してください。');
                return;
            }
            saveHistory(mesh);
            attr.array.set(data.colors);
            attr.needsUpdate = true;
            alert('カラーデータを復元しました。');
        } catch (err) {
            console.error(err);
            alert('JSON 読み込み失敗: ' + err.message);
        }
        e.target.value = '';
    };
    reader.readAsText(file);
});


////////////////////////////////////////////////////////////
// Camera Fit
////////////////////////////////////////////////////////////

function fitCameraToObject(obj) {
    const box    = new THREE.Box3().setFromObject(obj);
    const center = box.getCenter(new THREE.Vector3());
    const size   = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    const dist   = maxDim * 1.5;

    camera.position.set(center.x + dist, center.y + dist, center.z + dist);
    controls.target.copy(center);
    camera.near = maxDim / 100;
    camera.far  = maxDim * 100;
    camera.updateProjectionMatrix();
    controls.update();
}


////////////////////////////////////////////////////////////
// Resize
////////////////////////////////////////////////////////////

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});


////////////////////////////////////////////////////////////
// Animate
////////////////////////////////////////////////////////////

(function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
})();

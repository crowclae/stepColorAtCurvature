# STEP Face Viewer – FaceID Mode

opencascade.js を使って STEP ファイルの **真のフェイスID** を取得し、  
B-Rep の 1フェイス = 1解析曲面 単位でペイントできるビューアです。

---

## ファイル構成

```
step-viewer/
├── index.html            # メイン HTML
├── main.js               # アプリロジック（ES Module）
├── coi-serviceworker.js  # GitHub Pages 用 COOP/COEP ヘッダ注入
└── README.md             # このファイル
```

---

## なぜ coi-serviceworker.js が必要か

opencascade.js の WASM ビルドは `SharedArrayBuffer` を使用します。  
ブラウザは以下の HTTP ヘッダがないと `SharedArrayBuffer` を無効化します。

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**GitHub Pages はカスタム HTTP ヘッダを設定できません。**  
`coi-serviceworker.js` はこのヘッダを ServiceWorker 経由で注入することで  
GitHub Pages 上でも `SharedArrayBuffer` を有効にします。

> **初回アクセス時** に ServiceWorker が登録されページがリロードされます（1回のみ）。  
> これは正常な動作です。

---

## GitHub Pages へのデプロイ手順

### 1. リポジトリを作成

```bash
git init
git remote add origin https://github.com/<your-name>/<repo-name>.git
```

### 2. ファイルをすべてルートまたは `docs/` フォルダに配置

```
/  （または /docs/）
├── index.html
├── main.js
└── coi-serviceworker.js
```

### 3. GitHub Pages を有効化

リポジトリの **Settings → Pages → Branch: main / (root)** を選択して Save。

### 4. アクセス

```
https://<your-name>.github.io/<repo-name>/
```

---

## 旧実装（occtimportjs）との差分

| 項目 | 旧実装 | 新実装 |
|------|--------|--------|
| ライブラリ | occtimportjs | **opencascade.js** |
| フェイス認識 | 法線角度 BFS（近似） | **B-Rep FaceID（完全一致）** |
| 法線 | `computeVertexNormals()` で再計算 | **解析的法線（外積 + フェイス向き）** |
| しきい値スライダー | 必要 | **不要**（フェイスIDで確定） |
| 円柱・球の認識精度 | △（角度次第でずれる） | **◎（面の定義通り）** |
| WASM ヘッダ要件 | 不要 | coi-serviceworker で対応 |

---

## 動作の仕組み

```
STEP ファイル
    ↓
opencascade.js (WASM)
    ├─ STEPControl_Reader   → shape 読み込み
    ├─ BRepMesh_IncrementalMesh → 三角形メッシュ生成
    └─ TopExp_Explorer      → フェイス列挙
           ↓ フェイスごとに三角形を収集
           ↓ faceId を各頂点に付与（Float32BufferAttribute）
           ↓ faceGroupMap: Map<faceId → 三角形インデックス[]>
    ↓
Three.js で描画
    ├─ クリック → raycaster → 三角形インデックス取得
    ├─ faceIdArray[triangleIndex * 3] → faceId 取得
    └─ faceGroupMap.get(faceId) → 同フェイス全三角形を一括塗りつぶし
```

---

## メッシュ精度の調整

`main.js` の `BRepMesh_IncrementalMesh_2` の引数で精度を変更できます。

```js
// 第2引数: 線形偏差（小さいほど細かい、重い）
// 第4引数: 角度偏差 [rad]（小さいほど曲面が滑らか、重い）
new oc.BRepMesh_IncrementalMesh_2(shape, 0.1, false, 0.5, false);
//                                        ^^^         ^^^
//                                   線形偏差      角度偏差
```

| 用途 | 線形偏差 | 角度偏差 |
|------|---------|---------|
| 高速プレビュー | 1.0 | 1.0 |
| 標準（デフォルト） | 0.1 | 0.5 |
| 高精度 | 0.01 | 0.1 |

---

## 解析的法線のさらなる改善（発展）

現在は三角形の外積から法線を計算しています。  
真の解析的法線（円柱・球の数学的に正確な法線）を得るには  
各頂点の UV パラメータから `BRepGProp_Face.Normal()` を呼ぶ必要があります。

```js
// 各頂点の UV を取得する例
const surface2d = oc.BRep_Tool.CurveOnSurface_1(...);
const uv = new oc.gp_Pnt2d_1();
oc.BRep_Tool.Parameters_1(vertex, face, uv);

// UV から解析的法線を計算
const gprop = new oc.BRepGProp_Face_1(face);
const point  = new oc.gp_Pnt_1();
const normal = new oc.gp_Vec_1();
gprop.Normal(uv.X(), uv.Y(), point, normal);
```

これを実装することで円柱・球面の頂点法線が数学的に正確になり、  
ハイライトや反射が完全に滑らかになります。

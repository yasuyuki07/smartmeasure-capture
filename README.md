# スマホ採寸 撮影ツール

スマートフォンのブラウザ（iPhone の Safari、Android の Chrome）だけで、**動画** と **動きのセンサー（加速度・ジャイロ）** を同時に記録する Web ツールです。
記録したファイルを解析プログラム（smartmeasure PoC）に渡すと、写っている物の寸法を m 単位で計算できます。センサーの記録があると、動画だけの場合より縮尺（大きさの倍率）が正確になります。

アプリのインストールは不要です。https のアドレスを開くだけで使えます。

## 使い方

1. スマホのブラウザでこのツールの URL を開き、「カメラとセンサーを使う」を押す
   - iPhone では「動きと画面の向き」へのアクセスの許可を求められるので「許可」を選ぶ
2. 測りたい物から 1〜2m 離れ、物の周りをゆっくり回りながら、端末を左右に 5〜10cm 小刻みに揺らす
   - 画面上部の「動きの強さ」が緑（良い）になるのが目安
3. 10〜20 秒撮ったら止める
4. 結果画面の「まとめて共有する」でファイルを送る（Google ドライブ・iCloud Drive・メールなどを選べます）
   - 個別の「保存」ボタンは端末の「ダウンロード」フォルダに保存します

## 出力ファイル

| ファイル | 内容 |
|---|---|
| `smartmeasure_YYYYMMDD_HHMMSS.mp4`（または `.webm`） | 動画。形式はブラウザによる（iPhone は mp4、Android は mp4 か webm） |
| `smartmeasure_..._imu.csv` | センサーの記録。列は `t,ax,ay,az,gx,gy,gz`。`t` は録画開始を 0 とした秒、加速度は重力込みの m/s²、角速度は rad/s |
| `smartmeasure_..._meta.json` | 端末・動画の形式・センサーの記録間隔などの情報。Android の Chrome は `.json` を共有できないため、「まとめて共有する」では `_meta.txt`（中身は同じ JSON）になります |

センサーの値は W3C DeviceMotion の端末座標（x: 右、y: 上、z: 画面の手前）のままです。角速度 `gx,gy,gz` は `rotationRate` の `alpha,beta,gamma` です。実際のブラウザ（iPhone の Safari・Chrome、Android の Chrome）はこれを x, y, z 軸まわりの回転として返し、仕様の文面（alpha が z 軸）とは違うことを実機で確かめました（v0.1.0 の記録は `beta,gamma,alpha` の順ですが、解析側で自動で見分けます）。端末とカメラの向きの関係、動画とセンサーの時刻ずれ、端末ごとの符号の違いも、解析側で自動で推定します。

## 解析のしかた（smartmeasure PoC）

```bash
python scripts/measure_video.py --video smartmeasure_..._.mp4 --imu smartmeasure_..._imu.csv \
    --config configs/browser_capture.yaml --out outputs/my
```

## 動作の前提と注意

- **https が必須**です（ブラウザがカメラとセンサーの利用を https に限っているため）。
- LINE などのアプリ内ブラウザでは動かないことがあります。Safari / Chrome で開いてください。
- ブラウザのセンサーは毎秒 60 回前後で、Android の Chrome は値を丸めます（加速度 0.1 m/s² 単位）。それでも実機の検証（机の上のモニター 54cm・ノートPC 31.3cm）で、幅の誤差は iPhone 0.3〜0.6%、Android 2〜3% でした。Android の記録は手ぶれのボケとコマ落ちが多く、センサーだけで決めた縮尺は 7.6% ずれていました（解析は信頼度を下げて報告します）。
- iPhone のブラウザでは ARKit（端末自身の位置推定）は使えません。将来、より高い精度が必要になった場合はスマホアプリ版を検討します。
- 映像とセンサーの記録は端末の中だけで処理され、保存・共有を押すまでどこにも送信されません。

## ファイル構成

- `index.html` 画面
- `style.css` 見た目
- `app.js` 録画・センサー記録・保存の処理（外部ライブラリなし）

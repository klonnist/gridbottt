# gridbottt

Paper-trading (sanal / gerçek para kullanmayan) bir **grid trading botu**. OKX'in public REST API'sinden canlı perpetual futures fiyat verisi çeker, grid stratejisiyle simüle işlemler üretir ve sonuçları bir [GitHub Pages dashboard'unda](https://klonnist.github.io/gridbottt/) gösterir.

**⚠️ Bu proje tamamen bir simülasyondur. Gerçek para, gerçek borsa emri veya API key kullanılmaz. Sadece OKX'in herkese açık (public) piyasa verisi endpoint'leri okunur. Yatırım tavsiyesi değildir.**

🔗 **Dashboard:** https://klonnist.github.io/gridbottt/
🔗 **Repo:** https://github.com/klonnist/gridbottt

## Nasıl çalışıyor

```
.github/workflows/bot.yml    -> her 15 dakikada bir botu çalıştırır, data/ dosyalarını commit eder
.github/workflows/pages.yml  -> bot çalıştıkça dashboard'u otomatik GitHub Pages'e deploy eder
bot/                          -> bot kaynak kodu (Python, sadece stdlib, ek bağımlılık yok)
data/                         -> kalıcı state: state.json, trades.json, equity_history.json
docs/                         -> statik dashboard (saf HTML/CSS/JS, build adımı yok)
```

Her çalıştırmada bot:
1. `bot/config.py`'daki 8 coin için OKX'ten güncel fiyatı çeker (`GET /api/v5/market/ticker`).
2. Coin ilk defa görülüyorsa, son `LOOKBACK_DAYS` günlük mumlardan (`GET /api/v5/market/candles`) grid alt/üst sınırlarını hesaplar.
3. Fiyat bir önceki çalıştırmaya göre hangi grid çizgilerini geçtiyse, o çizgilerde simüle **buy/sell** işlemi üretir.
4. `data/state.json`, `data/trades.json`, `data/equity_history.json` dosyalarını günceller ve repoya commit'ler.

Bot çökmeye karşı korunaklıdır: bir coin için OKX isteği başarısız olursa (timeout, eksik veri, vs.) o coin o çalıştırmada atlanır, diğer coinler ve bir önceki state korunur; bot asla tüm run'ı çökertmez.

## Coinler ve sermaye dağılımı

| Coin  | OKX Instrument      | Marj (USD) |
|-------|---------------------|-----------:|
| BTC   | BTC-USDT-SWAP        | 1,250 |
| ETH   | ETH-USDT-SWAP        | 1,250 |
| XRP   | XRP-USDT-SWAP        | 1,250 |
| AVAX  | AVAX-USDT-SWAP       | 1,250 |
| SOL   | SOL-USDT-SWAP        | 1,250 |
| DOT   | DOT-USDT-SWAP        | 1,250 |
| NEAR  | NEAR-USDT-SWAP       | 1,250 |
| ETHFI | ETHFI-USDT-SWAP      | 1,250 |

- **Başlangıç bakiyesi:** 10,000 USD, 8 coin arasında eşit paylaştırılır (coin başına 1,250 USD marj).
- **Kaldıraç:** sabit **3x** — muhafazakar bir seviye seçildi; grid botları sık işlem yaptığı için yüksek kaldıraç, likidasyon riskini ve volatilite hassasiyetini gereksiz yere artırır.
- Tüm parametreler [`bot/config.py`](bot/config.py) içinde tek yerden değiştirilebilir (coin listesi, kaldıraç, başlangıç bakiyesi, grid ayarları).

## Grid stratejisi

Her coin için ayrı bir grid kurulur: `lower` (alt sınır) ile `upper` (üst sınır) arasında `GRID_LEVELS` (varsayılan 10) eşit aralıklı seviye.

**Grid sınırları nasıl belirleniyor — `GRID_METHOD = "auto"` (varsayılan):**
Son `LOOKBACK_DAYS` (varsayılan 14 gün, `4H` mumlarla) içindeki en yüksek/en düşük fiyat alınır, üste ve alta `GRID_RANGE_PAD` (±%5) pay bırakılır. Böylece her coin kendi güncel volatilitesine göre bir grid alır; sabit/manuel değer girmek yerine botun kendisi güncel piyasaya uyum sağlar. İstenirse `GRID_METHOD = "manual"` yapılıp `MANUAL_GRID_BOUNDS` içinden coin başına sabit alt/üst sınır girilebilir.

**İşlem mantığı:**
- Grid, alt sınırla üst sınır arasında `GRID_LEVELS` adet "hücre"ye bölünür. Her hücre, tabanındaki çizgiden **BUY (long aç)**, tepesindeki çizgiden **SAT (kapat, kâr/zarar gerçekleşir)** ile eşleşir.
- Fiyat bir hücrenin tabanına düşünce (ve o hücre boşsa) simüle **BUY** işlemi olur.
- Fiyat bir dolu hücrenin tepesine çıkınca simüle **SAT** işlemi olur, gerçekleşen kâr/zarar hesaplanır.
- Bu, borsaların kendi "futures grid" botlarının **long-odaklı / nötr grid** modudur: perpetual (perp) enstrüman ve kaldıraç kullanılır, ama pozisyonlar hep long taraftadır (fiyat düşünce alınır, yükselince satılır). Şu an ayrı bir "short grid" (fiyat yükselince aç, düşünce kapat) modellenmiyor; `bot/grid_engine.py` bunu eklemeye uygun şekilde yazıldı, istenirse `grid_mode` parametresiyle genişletilebilir.
- Fiyat grid sınırlarının dışına çıkarsa, geri dönene kadar o coin için yeni işlem üretilmez (mevcut açık lotlar dashboard'da "açık pozisyon" olarak görünmeye devam eder).

## Dashboard

Statik, build gerektirmeyen bir sayfa (`docs/index.html` + `style.css` + `app.js`), `data/*.json` dosyalarını `fetch` ile okuyup gösterir:

- Genel özet: toplam bakiye, toplam kâr/zarar (USD ve %), açık pozisyon sayısı, toplam işlem ve kazanma oranı.
- Coin bazlı kartlar: bakiye, gerçekleşen/açık kâr-zarar, kazanan/kaybeden işlem sayısı, kazanma yüzdesi, ortalama kâr/zarar, ve bakiyeye göre sıralama (rank) — hangi coin'in daha iyi çalıştığını gösterir.
- Filtrelenebilir işlem geçmişi tablosu.
- Equity curve grafiği (toplam bakiye zaman serisi) + coin bazlı karşılaştırma modu.
- Son bot çalışma zamanı ve veri güncelleme zamanı.
- Mobil uyumlu, karanlık tema.

## GitHub Actions

- **`Grid Bot Run`** (`.github/workflows/bot.yml`): `*/15 * * * *` cron ile her 15 dakikada bir botu çalıştırır, değişen `data/*.json` dosyalarını commit'leyip push eder. Ayrıca elle de (`workflow_dispatch`) tetiklenebilir.
- **`Deploy Dashboard to GitHub Pages`** (`.github/workflows/pages.yml`): bot her çalıştığında (`workflow_run`) veya `docs/`/`data/` değiştiğinde otomatik olarak dashboard'u ve en güncel veriyi GitHub Pages'e deploy eder.

## Lokal çalıştırma

Ek bağımlılık gerekmez (sadece Python stdlib):

```bash
python -m bot.main
```

## Riskler / önemli notlar

- **Gerçek para veya gerçek emir yok.** Tüm alım/satımlar hafızada/JSON dosyalarında simüle edilir.
- Likidasyon, funding rate, slippage, işlem komisyonu gibi gerçek perp piyasası dinamikleri modellenmemiştir — bu bir strateji test/izleme aracıdır, canlı ticaret motoru değildir.
- OKX public API geçici olarak yanıt vermezse bot o coin'i/çalıştırmayı atlar ve bir sonraki cron'da devam eder; veri kaybı olmaz çünkü state her adımda dosyaya yazılır.
- Parametreleri değiştirmeden önce `bot/config.py`'yi gözden geçirin; `GRID_METHOD`, `GRID_LEVELS`, `LEVERAGE`, `SYMBOLS`, `INITIAL_BALANCE_USD` gibi tüm ayarlar tek dosyada.

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)

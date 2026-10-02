const SK_DEFAULT_TEMPLATE = `Merhaba {{Alici}},
{{SiparisMagazadan}} almış olduğunuz mobilya ürününüzle ilgili sizinle iletişime geçmek istedik. Ben satış temsilciniz Hasan.

{{SiparisCumlesi}}

Takip no: {{TakipNo}}
Kargo takip: {{TakipLink}}

{{TekrarGidisUyarisi}}

{{PlanlananTeslimCumlesi}}

{{CokluPaketUyarisi}}

Kurulum sonrasında ürününüzle ilgili herhangi bir sorun yaşamanız durumunda, bu numara üzerinden bizimle hemen iletişime geçebilirsiniz. Size yardımcı olmaktan memnuniyet duyarız.

Ürününüzden ve hizmetimizden memnun kalmanız hâlinde, deneyiminizi 5 yıldızlı değerlendirmenizle paylaşmanız bizi çok mutlu eder ve memnuniyet duyarız.

Değerlendirmeniz, hem bizim için büyük önem taşımakta hem de diğer müşterilerimize alışveriş sürecinde yol göstermektedir.

Şimdiden iyi günlerde kullanmanızı diler, bizi tercih ettiğiniz için teşekkür ederiz.`;

const SK_DEFAULT_WARN_IF_DELIVERED = true;
const SK_DEFAULT_SPARE_DESI = 10;

const SK_PLACEHOLDERS = [
  "TakipNo",
  "TakipLink",
  "TekrarGidisUyarisi",
  "PaketSayisi",
  "PaketIfadesi",
  "PaketCumlesi",
  "SiparisCumlesi",
  "SiparisMagazadan",
  "CokluPaketUyarisi",
  "Alici",
  "AliciTelefon",
  "Barkod",
  "WebSiparisKodu",
  "TeslimatDurum",
  "VarisSube",
  "VarisSubeTel",
  "Adres",
  "Il",
  "Ilce",
  "PlanlananTeslimTarihi",
  "PlanlananTeslimGunu",
  "PlanlananTeslimCumlesi",
  "TeslimTarihi",
  "TeslimAlan"
];

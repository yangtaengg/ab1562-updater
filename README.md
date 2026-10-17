# AB1562 TWS Updater website

H25 cc ultra max / AB1562AE_ENC+ 기기용 펌웨어 업데이트 macOS 앱 소개와 다운로드 사이트입니다.

- 공개 주소: https://yangtaengg.github.io/ab1562-updater/
- macOS 앱: https://github.com/yangtaengg/ab1562-updater/releases/tag/v0.1.0-electron.2
- 앱에 지원 펌웨어 패키지가 포함되어 있습니다. 사용자가 파일을 고를 필요가 없습니다.

## 구성

- `/` 소개와 지원 기기
- `/check/` 입력값 기준 호환성 확인
- `/mac/` macOS 앱 다운로드와 실행 절차
- `/docs/` 지원 기기, 포함 패키지, 절차, 복구, FAQ
- `/legal/` 면책과 개인정보

## 로컬 확인

```sh
python3 -m http.server 8770 --bind 127.0.0.1 --directory .
```

## 주의

- Airoha, FlyCC, H25와 무관한 비공식 도구입니다.
- 펌웨어 업데이트는 기기를 손상시킬 수 있습니다.
- 공개 베타에는 벤더 펌웨어가 포함되어 있어 재배포 권한을 별도로 확인해야 합니다.
- 현재 베타는 ad-hoc 서명, arm64 전용, 공증 전입니다.

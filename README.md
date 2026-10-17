# AB1562 TWS Updater website

H25 cc ultra max / AB1562AE_ENC+ 기기용 펌웨어 호환성 확인과 업데이트 안내 사이트입니다.

- 공개 주소: https://yangtaengg.github.io/ab1562-updater/
- macOS 도우미 베타: GitHub Releases
- 펌웨어 파일은 이 저장소와 사이트에 포함하지 않습니다. 사용자가 벤더 배포처에서 받아 직접 선택합니다.

## 구성

- `/` 소개와 지원 기기
- `/check/` 입력값 기준 호환성 확인
- `/updater/` 브라우저 업데이터 (Windows/Linux 실험적, macOS는 도우미 필요)
- `/mac/` macOS 도우미 안내와 베타 다운로드
- `/docs/` 파일, 절차, 복구, FAQ
- `/legal/` 면책과 개인정보

## 로컬 확인

```sh
python3 -m http.server 8770 --bind 127.0.0.1 --directory .
```

## 주의

- Airoha, FlyCC, H25와 무관한 비공식 도구입니다.
- 펌웨어 업데이트는 기기를 손상시킬 수 있습니다.
- macOS Chrome은 RFCOMM 채널 3을 직접 열 수 없어 도우미 앱이 필요합니다.

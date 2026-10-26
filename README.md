# Valetudo for Xiaomi Mijia M30S (D103CN)

Experimental local-control port, tested on **factory firmware 4.5.6_1409**, Athena **r2405_release**, ARMv7.

> [!NOTE]
> **Why this fork exists**
>
> I reported that I had found a way to root my own robot and asked where to start adapting Valetudo. I received a 10-year ban from the upstream community.
>
> I continued independently and published the rooting tools for my own vacuum and this D103CN port.

> [!WARNING]
> This is an experimental project. Use it at your own risk. There is no guarantee against device damage, configuration loss or bricking. Keep backups off the robot, preserve SSH/UART recovery access, and block the robot from the Internet after enabling root/SSH.

## Getting started

- [D103CN rooting tools](https://github.com/Dark-V/D103CN_root)
- [Port documentation, build instructions and runtime setup](d103cn/README.md)
- [Change history](docs/d103cn/history/)
- [Русская версия](README.ru.md)

This port runs alongside the factory firmware. Feature availability and verification depend on the exact model and firmware; check the port documentation before installing.

## License

[Apache-2.0](LICENSE). Third-party license files and required notices are retained in the repository.

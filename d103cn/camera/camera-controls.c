/* Read-only sensor-subdevice query. Never opens video1 or starts/stops a stream. */
#include <errno.h>
#include <fcntl.h>
#include <linux/videodev2.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <unistd.h>

int main(void) {
    const unsigned ids[] = { V4L2_CID_EXPOSURE, V4L2_CID_GAIN };
    alarm(4);
    int fd = open("/dev/v4l-subdev0", O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) { perror("sensor open"); return 1; }
    int failed = 0;
    for (unsigned i = 0; i < sizeof(ids)/sizeof(ids[0]); ++i) {
        struct v4l2_queryctrl q = { .id = ids[i] };
        struct v4l2_control c = { .id = ids[i] };
        if (ioctl(fd, VIDIOC_QUERYCTRL, &q) < 0) {
            fprintf(stderr,"QUERYCTRL 0x%x: %s\n",ids[i],strerror(errno));
            failed = 1; continue;
        }
        if (ioctl(fd, VIDIOC_G_CTRL, &c) < 0) {
            fprintf(stderr,"G_CTRL 0x%x: %s\n",ids[i],strerror(errno));
            failed = 1; continue;
        }
        printf("id=0x%x name=%.*s value=%d min=%d max=%d step=%d default=%d flags=0x%x\n",
               ids[i],32,q.name,c.value,q.minimum,q.maximum,q.step,q.default_value,q.flags);
    }
    if (close(fd) != 0) { perror("sensor close"); failed = 1; }
    return failed;
}

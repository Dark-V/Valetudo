/* Consume completed factory BMPs, never open video1 or change sensor controls.
 * Bounded latest-frame pipe; input heartbeat loss closes the session. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/inotify.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>
#define W 640
#define H 480
#define N (W*H)
static volatile sig_atomic_t stopped;
static uint8_t pixels[N], display[N], lut[256], packet[N+24];
static float spatial[N], history[2][N], range_weight[256];
static float spatial_weight[3][3];
static double history_time[2];
static int histories;
static void stop(int s) { stopped=s; }
static double now(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return t.tv_sec+t.tv_nsec/1e9; }
static unsigned le32(const uint8_t *p) { return p[0]|p[1]<<8|p[2]<<16|(unsigned)p[3]<<24; }
static void put32(uint8_t *p,uint32_t n) { for(int i=0;i<4;i++) p[i]=(uint8_t)(n>>(i*8)); }
static int load_bmp(int dir,const char *name) {
    int fd=openat(dir,name,O_RDONLY|O_CLOEXEC|O_NOFOLLOW);
    if(fd<0) return -1;
    uint8_t head[54]; struct stat st;
    int ok=fstat(fd,&st)==0 && S_ISREG(st.st_mode) && st.st_size<=N+4096 &&
        read(fd,head,sizeof(head))==sizeof(head) && head[0]=='B' && head[1]=='M' &&
        le32(head+18)==W && (le32(head+22)==H || (int32_t)le32(head+22)==-H) &&
        head[28]==8 && head[29]==0 && le32(head+30)==0;
    if(ok) {
        unsigned offset=le32(head+10);
        ok=offset>=1078 && offset<=4096 && st.st_size==offset+N;
        /* Require the original grayscale palette, not arbitrary indexed colour. */
        uint8_t palette[1024];
        if(ok) ok=pread(fd,palette,sizeof(palette),54)==sizeof(palette);
        for(int i=0;ok && i<256;i++) ok=palette[4*i]==i && palette[4*i+1]==i && palette[4*i+2]==i;
        for(int y=0;ok && y<H;y++) {
            int row=le32(head+22)==H ? H-1-y:y;
            ok=pread(fd,pixels+y*W,W,offset+row*W)==W;
        }
    }
    close(fd); return ok?0:-1;
}
static float stripe_score(void) {
    int best[8]={0};
    for(int y=96;y<432;y++) {
        int count=0;
        for(int x=32;x<608;x++) count+=pixels[y*W+x]>=235;
        for(int i=0;i<8;i++) if(count>best[i]) { int old=best[i]; best[i]=count; count=old; }
    }
    int total=0; for(int i=0;i<8;i++) total+=best[i];
    return total/(8.0f*576);
}
static void process(double timestamp) {
    for(int y=0;y<H;y++) for(int x=0;x<W;x++) {
        int pos=y*W+x,center=pixels[pos]; float sum=0,weights=0;
        for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) {
            int yy=y+dy,xx=x+dx;
            if(yy<0) yy=1; if(yy>=H) yy=H-2;
            if(xx<0) xx=1; if(xx>=W) xx=W-2;
            int value=pixels[yy*W+xx];
            float weight=range_weight[abs(value-center)]*spatial_weight[dy+1][dx+1];
            sum+=weight*value; weights+=weight;
        }
        spatial[pos]=sum/weights;
    }
    if(histories && timestamp-history_time[0]>0.12) histories=0;
    uint8_t changed[60][80]={0},expanded[60][80]={0};
    for(int by=0;by<60;by++) for(int bx=0;bx<80;bx++) for(int h=0;h<histories;h++) {
        if(timestamp-history_time[h]>0.12) continue;
        float diff=0;
        for(int y=0;y<8;y++) for(int x=0;x<8;x++) { int p=(by*8+y)*W+bx*8+x; diff+=spatial[p]-history[h][p]; }
        if(fabsf(diff)>128) changed[by][bx]=1;
    }
    for(int by=0;by<60;by++) for(int bx=0;bx<80;bx++) for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) {
        int y=by+dy,x=bx+dx;
        if(y>=0 && y<60 && x>=0 && x<80) expanded[by][bx]|=changed[y][x];
    }
    for(int p=0;p<N;p++) {
        float sum=0.55f*spatial[p],weights=0.55f;
        int motion=expanded[p/W/8][p%W/8];
        for(int h=0;h<histories;h++) if(timestamp-history_time[h]<=0.12) {
            float weight=h?0.15f:0.30f;
            motion|=fabsf(spatial[p]-history[h][p])>18;
            sum+=weight*history[h][p]; weights+=weight;
        }
        int value=(int)lrintf(motion?spatial[p]:sum/weights);
        display[p]=lut[value<0?0:value>255?255:value];
    }
    if(histories) { memcpy(history[1],history[0],sizeof(spatial)); history_time[1]=history_time[0]; }
    memcpy(history[0],spatial,sizeof(spatial)); history_time[0]=timestamp;
    if(histories<2) histories++;
}
static int name_ok(const char *name) {
    size_t n=strlen(name);
    return n>10 && n<240 && !strncmp(name,"image_",6) && !strcmp(name+n-4,".bmp") && !strchr(name,'/');
}
static int too_hot(void) {
    for(int i=0;i<2;i++) {
        char path[100]; snprintf(path,sizeof(path),"/sys/class/thermal/thermal_zone%d/temp",i);
        FILE *f=fopen(path,"r"); int temp=0;
        if(!f) return 1;
        int ok=fscanf(f,"%d",&temp)==1; fclose(f);
        if(!ok || temp<0 || temp>=70000) return 1;
    }
    return 0;
}
int main(int argc,char **argv) {
    const char *prefix="/tmp/d103-live-camera.";
    if(argc!=2 || strncmp(argv[1],prefix,strlen(prefix)) || strstr(argv[1],"..") || strchr(argv[1]+strlen(prefix),'/')) return 2;
    int dir=open(argv[1],O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    int notify=inotify_init1(IN_NONBLOCK|IN_CLOEXEC);
    if(dir<0 || notify<0 || inotify_add_watch(notify,argv[1],IN_CLOSE_WRITE)<0) return 3;
    signal(SIGTERM,stop); signal(SIGINT,stop); signal(SIGPIPE,SIG_IGN);
    fcntl(STDOUT_FILENO,F_SETFL,fcntl(STDOUT_FILENO,F_GETFL)|O_NONBLOCK);
    for(int i=0;i<256;i++) {
        range_weight[i]=expf(-i*i/(2*7.0f*7.0f));
        lut[i]=(uint8_t)lrintf(255*powf(fminf(i*4.0f/255,1),0.65f));
    }
    for(int dy=-1;dy<=1;dy++) for(int dx=-1;dx<=1;dx++) spatial_weight[dy+1][dx+1]=expf(-(dx*dx+dy*dy)/(2*0.9f*0.9f));
    double heartbeat=now(),last=0,started=now(),checked=0;
    size_t pending=0,offset=0; unsigned seen=0,rejected=0,sent=0;
    fprintf(stderr,"COLLECTOR_READY\n");
    while(!stopped && now()-heartbeat<5 && now()-started<1800) {
        if(now()-checked>1) { checked=now(); if(too_hot()) { fputs("THERMAL_STOP\n",stderr); break; } }
        struct pollfd p[3]={{.fd=notify,.events=POLLIN},{.fd=0,.events=POLLIN},{.fd=1,.events=pending?POLLOUT:0}};
        int r=poll(p,3,100);
        if(r<0) { if(errno==EINTR) continue; break; }
        if((p[1].revents&(POLLHUP|POLLERR)) && !(p[1].revents&POLLIN)) break;
        if(p[1].revents&POLLIN) {
            char command[256]; ssize_t n=read(0,command,sizeof(command));
            if(n<=0) break;
            heartbeat=now();
            for(ssize_t i=0;i<n;i++) {
                if(command[i]=='Q') stopped=1;
                if(command[i]=='M') {
                    int marker=openat(dir,"keep-open",O_WRONLY|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);
                    if(marker>=0) { close(marker); fputs("MANUAL_CAMERA_OWNERSHIP\n",stderr); }
                    else stopped=1;
                }
                if(command[i]=='R') histories=0;
            }
        }
        if(p[2].revents&(POLLHUP|POLLERR)) break;
        if(pending && p[2].revents&POLLOUT) {
            ssize_t n=write(1,packet+offset,pending-offset);
            if(n>0) { offset+=n; if(offset==pending) { pending=offset=0; sent++; } }
            else if(n<0 && errno!=EAGAIN && errno!=EINTR) break;
        }
        if(p[0].revents&POLLIN) {
            char buffer[16384] __attribute__((aligned(8)));
            ssize_t n=read(notify,buffer,sizeof(buffer));
            if(n<0) { if(errno==EAGAIN||errno==EINTR)continue; break; }
            for(ssize_t pos=0;pos<n;) {
                struct inotify_event *event=(struct inotify_event *)(buffer+pos);
                if(event->mask&IN_Q_OVERFLOW) { stopped=1; break; }
                if((event->mask&IN_CLOSE_WRITE) && event->len && name_ok(event->name)) {
                    seen++; double timestamp=now();
                    if(!pending && timestamp-last>=0.09 && load_bmp(dir,event->name)==0) {
                        float score=stripe_score();
                        if(score>=0.15f) rejected++;
                        else {
                            process(timestamp); memcpy(packet,"D103",4); put32(packet+4,N); put32(packet+8,seen);
                            uint64_t ms=(uint64_t)(timestamp*1000); put32(packet+12,(uint32_t)ms); put32(packet+16,(uint32_t)(ms>>32));
                            put32(packet+20,rejected); memcpy(packet+24,display,N); pending=sizeof(packet); offset=0; last=timestamp;
                        }
                    }
                    if(unlinkat(dir,event->name,0)<0 && errno!=ENOENT) stopped=1;
                }
                pos+=sizeof(*event)+event->len;
            }
        }
    }
    fprintf(stderr,"COLLECTOR_END seen=%u rejected_sampled=%u sent=%u\n",seen,rejected,sent);
    close(notify); close(dir); return 0;
}

use strict;
use warnings;
use Fcntl qw(O_CREAT O_RDWR O_NOFOLLOW LOCK_EX LOCK_NB);
use Errno qw(EWOULDBLOCK EAGAIN);

my $path = shift @ARGV;
exit 74 unless defined $path && @ARGV == 0;
sysopen(my $lock, $path, O_CREAT | O_RDWR | O_NOFOLLOW, 0600) or exit 74;
exit 74 unless -f $lock;
unless (flock($lock, LOCK_EX | LOCK_NB)) {
    exit(($! == EWOULDBLOCK || $! == EAGAIN) ? 73 : 74);
}
$| = 1;
print "locked\n" or exit 74;

# The parent owns this pipe. EOF on parent exit releases the kernel lock.
my $buffer;
while (read(STDIN, $buffer, 1024)) {}
close($lock);

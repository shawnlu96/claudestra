import { gunzipSync } from "node:zlib";

// Protocol-only responses captured from the pinned public baseline in temporary state.
// No server algorithms, authentication material, or production data are part of these snapshots.
const PARITY = [
  "H4sIAAAAAAAC/+19W5Mb1bnoX5nSY8rCve7dfkNkZ29qH6p2BSp5SLmovsnWQTOaSBocQrkKAg42B1+SMoFgs4kTbpUQY1JswJ4QV52fcjLSjJ/yF87qe7d6qbX6KsnuPISx1N36vtXf/fqzVzv6wfT8aDyYvvLcyLI7Zzr7Q31vb7B3rnOq",
  "c360yz95tTO19V3+jfOfrs4/3x+P/rdtTvlH5lA/sOzuaGyetyfTsT4djfn3e6MLnTOAaYqGCFSc/53qTEYHY9N+dm8y1ff4fy1+s6JDQ2fU7ELDJl3cp6yrI4V0+V2AKdQgBqH8aRP7550zTDvVMUe7u4PppHPmZx1sUUJw38AaxipVgK4T",
  "04AWtZEJVGyYUNWoyZ/Dbzf6po4VAxP+IUA2AggbfWYTxABQkKpTyAxkG9C5lPQZtvW+gg0VU02zLGxQCHWNQQYhxEBVFGJrGr8UmbZlAR0yopiqriBiY/5HHwHm4KTqUFexovbNztlTndHL9vjlgX3BOUr7F4OJg8J0fGCLD2rXnurOlfu7",
  "Lqb6OXtv2t13Dp4/yhqZkx8Oxp0zewfD4anOzw/sA/tH49Ev7T3nlr7/V18fTvjTx7Y+GfF/dpxDHPBT9267ePFUZzC13ce/2hk4b6Jv61P3zU4H06FDBLNbf3z0/kcnn/16dusfO863B2N7B/zr7x/MPr56fPPz+e0vZrfvza5eP/r+tnfR",
  "8QdvHh++eXT4zez+N/Nrnxx99/bRd3+dPXxj/u69+dW78wc3+MNHe/b/Guw5j5+//fbs6p3jK2/N//DWoz++P/vtOycP//v4wcP5796a/fU9/qxHb12dXf/D7PvD2YN3jx7enV+70rl4Kg6sEQf20ldHD/4yu37v5OtPdybn9bFtdYe2dc4e",
  "h6BDDvrJnU8efX9jByvazuzXfzv+8+v8R+Y3/3H03bXZrf+eX/ls/tEnJ1/+MQnnlf8zv/3g+C9fzi6/d3Lnc+fSS5/Pvrp+8uWn8zcuzb68zx/Yucjfy1SfvBQ7zwFUu0+DjnfOz6484TLn+q+/Xz7+4osdsDP/6yf/99vhaO/cjvsT//r7",
  "Ff5rLw32nF83HdbmRDDl1MT/aXEM+T/HowPnW3DKIzL+hUdslv1y1wF+fzf8aD9gfP4JBs6Xk33bbAaNnf/32s2dk8/enP/h7/PfvH/y6ev81w/2LX1qW09PA/ZRsM8+Q30y/beXXXRe9UQH4Ag6LLdwoW46wmoBwak+PmdP42/QP0Hv6PgF",
  "9i+mHkdxAHSf6Zxz4jw+6A9sy7lmFJyxw2runc977CeA9cd2IBqi18GfZQ1c+bqvTybOuSudM/z6feD9B7pX+aDM7t7hlDt/8/rJZ87JhJhC5EmUi65IGQ/MiXsiHMPpC8E1AFEfFHvPeiF9RtPRVB8+53xO1UCOO+g85z3LJQEYXDzmGoC/",
  "lNgnxsFgaCWu8HANP9i1x+fiNwwHL8f/GZ5p9JF7rGccpLyH/dg5tIl7Ht4HP9UH0//i2HAN5kDpyUnB+blvxt73GP1V92+PgZ2/+LEG2MTZhP+C+18fz4CPLA7myw6Uvty1f2GbB3HiChgqfK8eVMF1/+mRmMeEXOvauvXCyJfVp0KALnAd",
  "LQAHNgWOvM6NAe2/8RTUKD/U4wWgA97Id4oexaXgwfnh8SVGqXfqEvgraXBIk+CcdWWhy3keePwubso5XHFupA8bFPLHt+5yg8CRmnE9CrP16FLlL63yfbBgHhUaE/f+u4MiNQqz1CiMqdFasZDToGCpBoUkoUGBvAaFOTSoK/x97Rke7xIN",
  "CrI0KKxKgxK0WoMqmlCDgpQG1WCFGhQH6rg/+EURfUpAgFlSjUJZNQq9Q4RNq1G4WWo0Pzjy/mhDatQ8r++ds/NrUofyqtCjazxGWFzd1mKNBPDQzbBGAnBYBA5HcnBuz1V7zVgky4G7KDJU6lejYhsFZdsobz2YvfbR/Ks/7Ay5SN25MBq/",
  "5EJUIAzig4fy2CppmzdtqKDlhsr56XR/cub06XOD6fkD4ylztHuaH+2FveGBRk97AUAn9Hd6n7+60xigmFXTCN4y1g3U1KXWDYJxnR9eKGHdoBzWTSh7XPvGeyVC4yYJan3hAf9nsowbqMCkceOxcGTTEKXGqADBYhtl4119tFk2Sn5wOn3D",
  "gsjULUNXdRNblq6YGEHLJH2CLENVqY77qqkZW+7qr0+bLcImVGbNSU+xUsPZSu3GZe7nP3rvux0XmZ1z/Ewd6CRC5j44OI8SE5BXzqg1jimmWmCXU0RkuSJiCflMhIooQDOpiXAOTeTJX18R+ce6RBMRgSbyCH+5zoAoW2dArUKdQZhYRyhL",
  "dIR/vUhNKG1EOK+a0DBRDYhs0tdUhnVEAKQmtpFlWgAAW6eWihDoKznVRB6xPC58jiKxnAJOKJfrEx6BHOYEPxyZL9lW7xUnB+wbm2eT4plkimfu0JzceefRu7dnb1zf8RP2g9EeB/T45kdHDz6bff/H47e/mX18f3bpWw7r/PKfZ7f+cfLW",
  "n2dvfz7/02vcZPRhJXmE9GJMIFdANKefQSJxXieuckIdLhXqGCeEOlwq1GFKqJPC7oXzHpaIdCjtXLgk6HsXwBOVwBeVEt6FRPJRoyu8C1qHd+FGTL0nF/EtFk6ijX/mDtzJFtk05FsEZF5t9DOPDqv9IEWqLomASM/VLlWztB1e1HY02xn5",
  "642dHz797zvHNw9n373haON3ruw88/TzO/PrN44efMzl9+zyb+e/u3d85fL89hc+YDSPagus5mJBNO+NBt5HVcBK6SZVW66bEg5HeKFE5IvmUk2BCHR1k3eQYu2UgFXW4cAgW40AUFyNUJTPv1gWg1IewxhUXhGHqrPTF4ETmumVclmWrCKL",
  "sorlqfw7PvzN7Oqd2Y1rJ2//6vhX9x/dfH1294N/vvb6/Ob9R+9/M7/7P44nwc2sK1zOfjK7/icfUla18AKSwqs26OWkGV0qzYiSkGZUXpqxmqQZLSDNkLpCmuES0oxuqTQDmyfNQMPSrF62yxJvruUlssl66QpnY3WAOFcatkRZM8wbIIZg",
  "ZYC4NOxla5kpKVjL3FtLLTNssJZZUVW5WmYI6AZVYq2sbN74kqztj2NLN/M8QSVZazrGtiQrb0nWRhSI16kuhcnpHsy0PZbHropnz2GZdHXu6nAIZfIb1WJTtk6cYYk6cWGuo5enUNwTcyvT1yuqxKvLdTC2OtehrghSMVChTcKIwCaRznUQ",
  "EMuRt+mOklF6xSm0Y4hgZEFMLEu1VYv2NaybADLIMNJ1VdN1Y7vTHVtwiALLYnMKDWC+BEwNYl+sZVG2h58KscrXQKCNSb6Ug7ls9TFjBauPe6ieqKWw/HhV1DIsBF6i3pQSzU/L6oDbHMwW5mAqYLaMWCU3IxdClDhbgC1EVXPltXOWr6Zp",
  "q7IcTGmwy1auOtNZVlauCoVYnsJVF/vQ8PfOs8LCVZZtoqs5LPS8Zam1iqw1ZjbS4MnkNqoh5ywx4dRSOtN0gtP0CSwc+uGS2GIDs/sYJ6B04bwzZCceJfeP2jus8JADZWH3+7Z/MsFH5th2mMsBKckd/hch1wEWaM5Ffgy+ceRdHH6YgB9t",
  "HfwoAT8uA79Pj0kMwg9rxAFUh8Na3gFOwE+28h2QBA50K3GgCRzYVuKAtx+HXoKfe1unE3oJndBDW/kOEnqhhx8DOtoCvcC9Kf6bU30wdO1dX7k5IyH1yUvuJ+24u3bcXTvurh131467a8fdtePuCo6769iOCPcZ0hXiMckWSa18MtxR0Wf2",
  "vKZAX3b+/bXZ1TsxYb6vT83zvpx0VaUr4y66SSBv8lscDqrUo0uWxPWCrvg4CGpN6mxZfiRolIkrGkXN0ZgfA8KyHXk/jsDwiOPk+7tHDz4+Onw/BpVDsM//x9O5pFAILKkC2KJTBII6VYFmXoRhvAKEqKXVg+HRax+cPHzrX39/Z3b9y6PD",
  "T7yaoxhgeQ0K7/n2AkARDkwChwoITzgWyAdBTUwjpPWAEOgIFwLXJIkASMT11WL8H0r9gOwfPOSy8tGf3zn58vX467MnB8PwnUUgAKUCGAoPn9wEo9qZLz7Y5dLDsd1+tiCsT/k3L6gK5/6E1PbU8GIyKn5vKN6je1Wcujfg+/idKl68M5A7",
  "yV/1ST12aySfolsRTN0akGj8zpAjozsJTd3pv9f4jSR1RgFVxW+MvYv4zWrqkAJqiN/sWzGxG+NOxuKNZ0+19nhrjz/B9njrmbac0HKCwDOd2JPJYLTnhp+8PT3uX4Lw5cW4Pbt4SWDYCvbNXDwVZI2FQd129no7e72dvd7OXm9nr7ez19vZ",
  "6+3s9U2ZvZ4OmCci1YpWSE1WETEHiXg1QvXo6+yQOYjHq0E487RiGFbEzAFJBO5zNAPGoSgUNJeXTxG0tApoS0bNQSLkrBD5sDnMCJvffo1bnScPb86+/cThxH/cP373nfmHd44Ov5n/7c7Jp78+vvW7FVH0SE2lrRCJQDpQJdAqf7bCEZgB",
  "CIlANtQqJEZYPTFCpQpoi/XRBiAAgTFemhTlMjiwqgwOhBJIVCAHs1I4EAlahSuHISuHA3EFHmTJJM5avdgc+ZPQcIhyIAhJ5k9CXR/dG/aBZOdPQg0dy7wAqfxJpKliqReSutXj9ETehaTu8+XMypQN1NKJFySVsiGpE4p65zNTNoylkydA",
  "MmUTjwcsBr+ayLy0XnPrNbde8+PvNbehuFaotEKlFSprCMXJpglh6TQhEqcJ2/WH7frDdv1hu/6wXX/Yrj/c6vWHqbwSTFSyK7CQdKykEyORG4C0HjGdnVeCyXp0pS5VkZlXgolQPsNLg+MoC4pCeSV5uRB1ryhVQFsyr4SAhIoXBvPR5rRj",
  "rNNOkY8gRyIiFlilchHkiKtjkVVFJoIc8WIssorlwrksXbyvqVLhXE1da2C1tTNaO2ONIbiW/FryK2DmysZqUOlYDRbHatqt3u1W73ard9te1G713pit3qmoA0oUDcEchUu42qgDSkw+wKwQIGUHQCQGGjBQDwwrog6IViHFC0Ud5Pkxgnad",
  "OieHswzTBUGYSTrLmKVdXiDlLLN0zZRG5JxljazV5W2Vy7qVS2tLtLZEypZork2XiH06kunT1bnIfalnt1gXk6s/N2fOncisyqpoaf1KTxAuX7eeMKY0mKOsn5TtgxD5gbCZ9ViaxGBGja7ItNM6Mu1uA284Hyd3nr3djVW2eI30Gbb1voIN",
  "FVNNsyxsUAh1jUEGIcRAVRRia9p278bKu3+h1oMU6bQkAvk2UVUkVbNcZCx2keO56Eh+SHiFpGIXOdlaphQCpKSLjBNZZozrgWHVkMRElpmqxdRbsYZPafqPoIVVQFsyMY+RhEUgTMyTWhs+M/X9qkT9Gs2cHJ1eWjrXDhXZPH06246lJuVF",
  "rBndSSUn5dH0pDwNSnR6abBtf2qtlK2zUlpTuiXSx8GUbq43g4pjQzQ735/a0PjOlZ1nnn5+Z379Bje4Tj57c3b5t/Pf3Tu+cnl++wvfjKcbs7u1ILBSkRxVWx7JSeRX1BzTZmg9S1sTsMrm9PGKneSgxE5yitqlrY/N0tYyXJbl2ROhZ48T",
  "+V4MCjFXFZ49TuR8KamHy1d49uuUNDkyuTidU6VE0p2i6VkUqiblTqna416B3JysaKVsrVK2YN2nPwh4udXHxFYfy7ON7fjwN1w0zm5cO3n7V8e/uv/o5uuzux/887XX5zfvP3r/m/nd/3HKnu7emV+5P7v0yez6n3yZz6o2Awuuv64Oejm7",
  "kC61C0lyV0WOoDSryS6kBexCpK6wC3EJu5BuqV0INk9igYbtwnrZLstQdH3Y5bkgnOhLRGohtqvEYkzkgiish/+zLca1yqAcFiNKx7MplLUY0012KpWzGOnjXsDXnBRp5e9GWIwgn8XYE+/v7aX39xqr+4JyzXUusbQX5u0LgmBlX1Bp2Mtu",
  "6qWk4FKx3lo29cIGN/Uqqiq3qRcCukGrHVbu7d34HQ/bX3KMTNuygA4ZUUxVVxCxMf+jjwCDhs5UHeoqVtS++SQNllvTMbaD5fIOltuI9cd1qsuMUTskXj8WKYB86rAKL44kdkkAWI9eXuHFoYIboHsVrj0mWGL9s7CNrFd277G8+ImgJVVA",
  "W7Kij1CJddXjFTBs3goHwiTQKn+2WSsciFp0r/VKYoQ1EKNWBbSlVjhQpeAS7h7YnBUOFBTcwt2rbgs3hQXXcPeqWsNNUcEd2L3q9nBTXAEMZfdwr9Vllg9uRtZLtNEBSAY3I4MjtoNCKrgpvf1bsEdCbvl3qrq4Xf3drv5uXfrWpW9d+vW6",
  "9G2MsBUorUBpBcrWL6LviRfR92BmdnJ5f3LxaeGwzBzD3AvpIZSZYVEtNmVX0zOZxYLCRs9e6TWVuRfTVzfPIlxZlzHPQl3RWsFAhVlLRgRZS+l5FgTEhie2Iy1Kto8pzlRshghGFsTEslRbtWhfw7oJIIMMI11XNV03trsPbwsOUWBXbM7U",
  "KJhvyEYNYj8jD0dlVmELY2wVr1KnMuuwVwFSMg9HVYlVzKVhWJGHo5rEHuOVirZQHk6eFUNomVIFtCXzcAxIrF0WJj/g5k7WYFACqfInm5WFY6gKm69QFq4IKa7PQs0xikRuh7O4Elpuj7OoElpujbMwci+3xzk9ikRujbPoJ9slzq1h2hqm",
  "2zW9tuWZlmeeGGeusTEvPfEK3h7Kbt9IzXSQ32uANmbaSzmYyy7KZazgAroeqqe5V7gpd1Vzb7gpbklkMtxfVyAyuWxlbTv0ZQuHvlTAbBktvdy/EnXyMlJww2iv4nWrjErs7SzN7Nmxp7UKnBydvLLLJ0X+q9z2SZH/+vhvn2xnv7SzXzJN",
  "QfGGvx7ONgUXxjjkGuCdc7lfmnAqG/pSGuyye/2YJrFjSSidK1iNVdVaP5adp1ZzpKnzLu2r1fhbYyt/GjyZYSrVkHOWwSXeNMfUgsvVehVvmlsnO+WwdWR3h4lsnRqWh23RsI+NY8nK52s4l40uuM9z5+kAr53GOQZwKpbIwhYlBPcNrGGs",
  "UgXoOjENaFEbmUDFhglVjZr8sZ11NAc0V6bb5FbpXAujyxRYZpRyguKVrsJfcih98pJDHWddFa8H2vn5g91dffxKWsvMPr56fPPz+e0vZrfvza5eP/r+tvfV8QdvHh++eXT4zez+N/Nrnxx99/bRd3+dPXxj/u69+dW78wc3cg5BcYD44eAc",
  "J9WAc33mt59xLET+DrqKF+Z0+QRGfILjfGL0TR0rBiacIwCyEUDY6DObIAaAglSdQmYg24CddSQAm8tTNFyD3lTmoMma8MbKvfNVcpfdTC8lAi59dfTgL7Pr906+/nRncl4f21Z3aFvn7HHemQ6wQu6HEfejkPtZnPn7hgWRqVuGruomtixd",
  "MTGClkn6BFmGqlId91VTMzrriPXUxvxoa5RkI7T71oPZax/Nv/rDzpD7jTsXRuOXXLItXg+JKqRhFNEwDmmYnCqyubk19KpL7EoRVn3L3suZQkQsDKWXkrSWUGVlFk2upZGh2aY32+ZU4zSkXBSjXD+Eu9kKunS2QErk1Lm7Jqe6Yut8V6DR",
  "d5WlHl6NypHNQZC5cH9ltG/vdfwg6mDvnIfr6GBsesG9/eErrnjwb/eCR4Nfxp+g700u2GMXzugp/gkHD9q3x7sDNwblLpOScuFrHnafT131YhGuhOEj3RjcGj6b77mD1nOvtAe7hIFay8jinDwfReu0U0W6M1oTdR0maoOhuiYcuHW2yOcz",
  "jHuoNYxzGsbVl/nms497UTgHVvPKqrRapS3FWipkZJUFP0qn8uiAn457WIOVe6h2/Ot3QJlMFX/46MKePf7paOwUn3QKiAPv7P3UMAc9OG3/Q/8F65PRnp+HHuwNpgN92Ak+fsGvgbj8IXfmPMfOrWga7Y8mXklG0jrQ9/l3L/vfuNDzD03+",
  "rHgpUjTcz9T3THvok8LE5L7KM64BGJIUJxSn9CtMVFv+O3jJfiVY9eIQGBcjXkK/iTShS/n7PtD9wdD+9+HIcP7ZuWAbpwNSOW2OhkPdOO3AqIPTP/hBh1/NaW2w6/EROO9Wf3j4BZi4nliEGkyiVmv6I8IqAEYaO5jGDqaxg4vYoSR2jQTI",
  "F7GE8liiNJYojSVaxBInsawlWruIFQp2TOV4iTiNHk6jhxfRIwn06gzsLSKJ5XEjUuxHFnGjyVdX4XrpBCJEHhEqxWl0ERFVXo6UFJj8/18GO7NrH3ncWkxaqitI0bMiHBxT+gwu6LOx/fODwdje5SrqRS+2sKjauODkyHgM6LGbQ5jXbzx6",
  "764Xl6pA3zG4Ut9NxwetumvVXavuWnXXqruS6o5lichqFwQnMIuv9pRFkUmxGVufRt9RJTBnnaqVu6veB+Kun6XYhn43lFYRKSdbQjQ9AV51D8jI8SpWJua0LQwp26K3aFv0oKTgrnzIapxPevIKypCyMnqLVkYPrRDipWclJPCRtycMKXui",
  "t2hP9Ii8oJNRUIGmrcJPMVbp2SfZT2kFSCtANkKA4ExjsIqO4QRCgS+S501J+SI93JBozMJO3rCVFY6updeZ2vquIx+Hg4nXlWyet3f1n8TsKecK9yycP1yRNrHHXJw+7w4VdSTWvm4MhtzOst2uNR+mp/a8ydn2nm4MnVSVI7+ihM5TE3sq",
  "+trSzz3lGG3LvhvbXsZR8LWDX+pXfbvL9PJKXp6MY/bi3mj6oveuQnHPv/8J2Dk6vOS9UO9dOUvK3DbUo8Ors9uc6w5ntx90fGAMV4WU+rXvrs4uvX5y9zvvNz0XyfnNb//G//bUi6srvz16+OHxu7/vXAw74wv/rC9BPZfr8NLxza+Of394",
  "cveeh9v82ucnD285v+NpLqfRuPBPee5c/Og4bvPLN2a/ef/kwV+ODr/n+M+vXT56cNm7cv7hGy6Gcb1X8ni5gzW7/t7JO2/Mbn09u/7+/NbXnBXndy53UtlFvwJv+spz3vP3h/renlNy5/zigdvw/GrQEu02mpuj3f2hPbW9dK1bhecU6AWb",
  "pTtniEMn9sQcD/anA//spZycIJ/77B5/2dwgeNZyWV7Rnco3anahYZMu7lPW1ZFCuhoigCnUIAahDuefH+3a0a1OXY3Mjac8r083gK0Zlt4lOlO7TrNcVzew3u2bOqJqX9WQanoWj6N63cebQ/3AsrujMRcek+lYdzLR4RUu4q92uNRyxEZs",
  "KQCBYfe/aQ/EX3lljkVw8e50hRRQ6MVkMcuB43D6Hb71ubepNQghWv43rk3ovKzIr3W3dZejRSikRTVNi4Wy2uskTUMlnB4B7KqmYnUxAIBrO67ymKmbGFmI0y18TEmzjhqHovR51iWlqT4Y+jUsrc3Q2gxPms0QDXxopXQrpTdQSrviZjH0",
  "FQWMouDNop+YL9O81gS5Yyqlk8mLcZd8yeV1pcVTuEBRzCVfCnndSfAUTsmE8WLYJV8CuencdwoZ3CnMPSSNQ4MJ7hQmpDjb0DQmdaWzU2An077FWIWl4W8si51CiBXnCjWNx7pT1U69uWPuchvH0zmO9vnPpL4II60EGkYfGXrXhn3axUg1",
  "uY5B/J+WZmkII6rZqntgCw+B8Ydo2LKJRUjXRpbWxTbgWh06fxFCUZ9C20ZY9BAUfwhQMDdaEOpyo6XPIQEGVw4W6ioGVnVTsbGFqOghOP4QaCsWM1XQNYmtdrHCL9CYaXVNqnFgbMPSqRAdEn+IYWj8IJDSRRRwSCg3Ugxdp10F9C2T2oZG",
  "gCl6CE0cbN8mpsYfwiFBHB2Cu7pFzK5FDAaJqhJCDNFDWOJMdKVvQ1XpqgyxLlax3lX7htFlkBtLzIZQQxyds75H5cfTwlYDUZ+EqD4qbbXKm2v9g+HQT9g5ttCLo73hK/5Yt3BM5DjZPfvjoFMlsvQ0EvzzhYVqK1HXwsYMGllYcx9rL4kQ",
  "xYsmbfhvfrWLqXv7GdARtJy4HT/Rs8DKZ/kNLYmnuT1HC09CEk9ymsVWPgiufJAbBBA852wR3g+pPGrM9hK0md3gF8+KW11SFWfhPISN4AqgADFbMBm2aLb3fGHYt5AVqiPfIlQXMdXZ3BL2VLZYBeni2nBAVjOUhAHOEq9MTEdYho6aG7ez",
  "uEOsZiIqJAOXieZq5KC0+SJJjXUSX55RqB6JggwSZVBMoiC/qGtsUqZPr35Pb2XaX0SrG6j5ycoHebMYGjIhpB2ZXPYx2RD7WBNzB5XhjlqHF22r3pd2z7LIBQqbauqTuDmG6noSF2bRFBbTFJShqeYHk/qE5sqUgW0VF7j9wS9W0hmVFNvw",
  "cRTb/oNW4cZk5T9szHySjkPlYmpcM1PLz4eU0RSqmKuJBFc3PqUwsWy4InZ+4mInctFKtyq/rRhpK0baipG2xrStMV1bjWmt1SFGujqkqbakxZxqr3hJiJEuCVlXM1IKq+LFIUa6OKTu1qMU9MlenUIJbyNdBlJ7x1EKj+IVIEa6AqSRtqIV",
  "OfleIiePTBsAQ1e6lAGjizEFXU1FsGsoFFDG/X1qI0HquJfIyTPAVKQB1CWm8xDIMH93fbULqKURBpCmYk30kERO3tSAaitWv6v3GeJulKF0DQqULtFM7msxgFVFCEkiJ69BDKHCtY6iaRwStU+6us0fomom6ANTg9SkeZLYTcW3cwxCdqMt",
  "MCu+rYoz3D1QPAVTz0DZSoLabYxljTGW+lxNacGUJ77SA03lSCHMTLaLM1A9WCpy0sBIW6m0aTU8+7jwWr1hSGnVm6emoBfUFPTQplSnLFFpuEB1Sj3zblMbXStMT4nTSnK2Ts4sZA9uyhtH4jeOCqUhaxgVva3ZSDk7+6xzz3Bk6sMfRaEt",
  "qbaf2PhmqRhQOITKW/K8GD7zt6B40Sh3j707ziAKIvsqcGn8KL2At1Q8KNhBbY52dwfuhuw8xSk5sqo5cjXS3gN/pyNuxXk731/lbD6YOCh4ZY2igwpm6+zvupjGxt7wR1kjc/LDQcjLPz+wD+wfjUe/tPf8TdruX36sNYymOofo7aN3p1Q4",
  "s9Sn9m7z07+jCE+B9rsGB6jFIlESQd+A1WPnGVUJ8nN+duUJ1zfp1K+bdaPuKe8vGoov2qzN2Xx3ceySo0U6XAj5CmF9xVmpAK2CffYZ6pPpv73souOvr3cK08L19dGFq9fXu29Qdn19rHLBXWHvaZQg5fO8x34CWH9sB6Iheh0Li3b4uStu",
  "cmIfeP+BfnLPm7p39w6n3Pmb108+c04mxBQif/e5K1LGA3PirV3Xx9MXJqkZe/ae9UL6jNxsyHPO51QN5LiDznOTYMcBV5M4TAb4WjD8xFPU8Ss8XMMPvNL66N9Ddzl8+M/wTKOP3GM9o4Rr33/sHNok2OzAP/ipPpj+l+2G4hwofesnfX4X",
  "PfvBY/RX17DrKrrOn5nmMaFntr0wanoh1kpw5HVuk4tx855ivSvm80JT8x56OXDOngoSasEAPC5Yxq5sOzdykqGNCfnjW3e5QdC5GKr6sGItQ4/WPVZbrEJj4j5at5RWozBLjcKYGm284i6tQcFSDQpJQoMCeQ0Kc2jQoZ/THcWPd4kGBVka",
  "FFalQQlarUEVTahBQUqDarBCDYoDdewUVxXQpwQEmCXVKJRVo9A7RNi0GoWbpUbzgyPvjza8ojLvQda61q6ZY6x8JWZJa6TivZllrRHBcs0829IqsUiWA3dRZKjUr0bFNgrKtlGaWo4htlXSNm/aUEHLDZXz0+n+5Mzp0+cG0/MHxlPmaPc0",
  "P9oLe8MDjZ72AoBO6O/0Pn91pzFAMatmbb3bi9aNswF1mXWDYFznhxdKWDcoh3UTyh7XvvFeidC4SYJaX3jA/5ks4wYqMGnceCwc2TREqTEqQLDYRtl4Vx9tlo2SH5xO37AgMnXL0FXdxJalKyZG0DJJnyDLUFWq475qasaWu/rr02aLsAmV",
  "WXPSU6zUcLZSq2sXkliJCcgrZ9QaxxRTY13vaUVElisilpDPRKiIAjSTmgjn0ERB+tRVRP6xLtFERKCJPMJfrjMgytYZUKtQZxAm1hHKEh3hXy9SE0obEc6rJjRMVAMim/Q1lWEdEQCpiW1kmRYAwNappSIE+kpONVF2S3lxsZwCTiiX6xMe",
  "gRw+FXSrOH0G4ZC/s0nxTDLFc8273MRCejEmkCsgmtPPIJE4b7qzMS3U4VKhjnFCqMOlQh2mhDop7F4472GJSIfSzoVLgr53ATxRCXxRKeFdSCQfNbrCu6B1eBduxNR7chHfYuEk2vhn7sCdbJFNQ75FQObVRj/z6LDaD1Kk6pIIiPRc7VI1",
  "S9vhRW1Hs52RCrd7ilVbYDUXC6JFJZN1j2xJ6SZVW66bEg5HeKFE5IvmUk2BCHR1k3eQYu2UgFXW4cAgW40AUFyNUJTPv1gWg1IewxhUXhGHqrPTF4ETmumVclmWrCKLsorlqfyrdoFvceEFJIVXo4Mn09KMLpVmRElIMyovzVhN0owWkGZI",
  "XSHNcAlpRrdUmoHNk2agYWlWL9tlibf4PPiEnOulK5yN1QHiKnakypQ1w7wBYghWBohr6cnNU8tMScFa5t5aaplhg7XMiqrK1TJDQDeoEmtlZfPGl2RtfxxbupnnCSrJWtMxtiVZeUuyNqJAvE51KUxO92Cm7dHgPnO5dHXu6nAIZfIb9c8f",
  "yFMnzrBEnbgw19HLUyjuibmV6esVVeLV5ToYW53rUFcEqRio0CZhRGCTSOc6CIjlyNt0R8koveIU2jFEMLIgJpal2qpF+xrWTQAZZBjpuqrpurHd6Y4tOESBZbE5hQYwXwKmBrEv1rIo28OveqTdWpIv1Q+qyFN9zFjB6uMeqidqKSw/XhW1",
  "DAuBl6g3pUTz07I64DYHs4U5mAqYLSNW6YzSSQownC3AKh9mudwfSNNWZTmYWsYr5alcdaazrKxcFQqxPIWrLvah4e+dZ4WFqyzbRFdzWOh5y1JrFVlrzGykwZPJbVRDzlliwqmlPBtO4QoJLNqfOhI0MLuPcQJKF847Q3aSu0rco/YOKzzk",
  "QFnY/b7tn0zwkTm2wzHSCe7wvwi5DrCFydOpbxx5F4cfJuBHWwc/SsCPy8AfzgmPYxB+WCMOoDoc1vIOcAJ+spXvgCRwoFuJA03gwLYSB7z9OPQS/NzbOp3QS+iEHtrKd5DQCz38GNDRFuiFs+4elKk+GLr2rq/cnJGQ+uQl95N23F077q4d",
  "d9eOu2vH3bXj7tpxdwXH3XVsR4T7DOkK8Zhki6RWPhnuqOgze15ToC873W14MWG+r0/N876cdFWlK+O8qdDe5Lc4HFSpR5csiesFXfFxENSa1Nmy/EjQKBNXNIqaozE/BoRlO/J+HIHhEcfJ93ePHnx8dPh+DCqHYJ//j6dzSaEQWFIFsEWn",
  "CAR1qgLNvAjDeAUIUUurB8Oj1z44efiWs2Dx+pdHh594NUcxwPIaFN7z7QWAIhyYBA4VEJ5wLJAPgpqYRkjrASHQES4ErkkSAZCI66vF+D+U+gHZP3jIZeWjP79z8uXr8ddnTw6G4TuLQABKBTAUHj65CUa1M198sMulh2O7/WxBWJ/yb15Q",
  "Fc79CantqeHFZFT83lC8R/eqOHVvwPfxO1W8eGcgd5K/6pN67NZIPkW3Ipi6NSDR+J0hR0Z3Epq603+v8RtJ6owCqorfGHsX8ZvV1CEF1BC/2bdiYjfGnYzFG8+eau3x1h5/gu3x1jNtOaHlBIFnOrEnzhrhSbTk2v1LEL68GLdnFy8JDFvB",
  "vpmLp4KssTCo285eb2evt7PX29nr7ez1dvZ6O3u9nb2+KbPX0wHzRKRa0QqpySoi5iARr0aoHn2dHTIH8Xg1CGeeVgzDipg5IInAfY5mwDgUhYLm8vIpgpZWAW3JqDlIhJwVIh82hxlh89uvcavz5OHN2befOJz4j/vH774z//DO0eE387/d",
  "Ofn018e3frciih6pqbQVIhFIB6oEWuXPVjgCMwAhEciGWoXECKsnRqhUAW2xPtoABCAwxkuTolwGB1aVwYFQAokK5GBWCgciQatw5TBk5XAgrsCDLJnEWasXmyN/EhoOUQ4EIcn8Sajro3vDPpDs/EmooWOZFyCVP4k0VSz1QlK3epyeyLuQ",
  "1H2+nFmZsoFaOvGCpFI2JHVCUe98ZsqGsXTyBEimbOLxgMXgVxOZl9Zrbr3m1mt+/L3mNhTXCpVWqLRCZQ2hONk0ISydJkTiNGG7/rBdf9iuP2zXH7brD9v1h1u9/jCVV4KJSnYFFpKOlXRiJHIDkNYjprPzSjBZj67UpSoy80owEcpneGlw",
  "HGVBUSivJC8Xou4VpQpoS+aVEJBQ8cJgPtqcdox12inyEeRIRMQCq1QughxxdSyyqshEkCNejEVWsVw4l6WL9zVVKpyrqWsNrLZ2RmtnrDEE15JfS34FzFzZWA0qHavB4lhNu9W73erdbvVu24vard4bs9U7FXVAiaIhmKNwCVcbdUCJyQeY",
  "FQKk7ACIxEADBuqBYUXUAdEqpHihqIM8P0bQrlPn5HCWYbogCDNJZxmztMsLpJxllq6Z0oics6yRtbq8rXJZt3JpbYnWlkjZEs216RKxT0cyfbo6F7kv9ewW62Jy9efmzLkTmVVZFS2tX+kJwuXr1hPGlAZzlPWTsn0QIj8QNrMeS5MYzKjR",
  "FZl2Wkem3W3gDefj5M6zt7uxyhavkT7Dtt5XsKFiqmmWhQ0Koa4xyCCEGKiKQmxN2+7dWHn3L9R6kCKdlkQg3yaqiqRqlouMxS5yPBcdyQ8Jr5BU7CInW8uUQoCUdJFxIsuMcT0wrBqSmMgyU7WYeivW8ClN/xG0sApoSybmMZKwCISJeVJr",
  "w2emvl+VqF+jmZOj00tL59qhIpunT2fbsdSkvIg1ozup5KQ8mp6Up0GJTi8Ntu1PrZWydVZKa0q3RPo4mNLN9WZQcWyIZuf7Uxsa37my88zTz+/Mr9/gBtfJZ2/OLv92/rt7x1cuz29/4ZvxdGN2txYEViqSo2rLIzmJ/IqaY9oMrWdpawJW",
  "2Zw+XrGTHJTYSU5Ru7T1sVnaWobLsjx7IvTscSLfi0Eh5qrCs8eJnC8l9XD5Cs9+nZImRyYXp3OqlEi6UzQ9i0LVpNwpVXvcK5CbkxWtlK1Vyhas+/QHAS+3+pjY6mN5trEdH/6Gi8bZjWsnb//q+Ff3H918fXb3g3++9vr85v1H738zv/s/",
  "TtnT3TvzK/dnlz6ZXf+TL/NZ1WZgwfXX1UEvZxfSpXYhSe6qyBGUZjXZhbSAXYjUFXYhLmEX0i21C8HmSSzQsF1YL9tlGYquD7s8F4QTfYlILcR2lViMiVwQhfXwf7bFuFYZlMNiROl4NoWyFmO6yU6lchYjfdwL+JqTIq383QiLEeSzGHvi",
  "/b299P5eY3VfUK65ziWW9sK8fUEQrOwLKg172U29lBRcKtZby6Ze2OCmXkVV5Tb1QkA3aLXDyr29G7/jYftLjpFpWxbQISOKqeoKIjbmf/QRYNDQmapDXcWK2jefpMFyazrGdrBc3sFyG7H+uE51mTFqh8TrxyIFkE8dVuHFkcQuCQDr0csr",
  "vDhUcAN0r8K1xwRLrH8WtpH1yu49lhc/EbSkCmhLVvQRKrGuerwChs1b4UCYBFrlzzZrhQNRi+61XkmMsAZi1KqAttQKB6oUXMLdA5uzwoGCglu4e9Vt4aaw4BruXlVruCkquAO7V90eboorgKHsHu61uszywc3Ieok2OgDJ4GZkcMR2UEgF",
  "N6W3fwv2SMgt/05VF7erv9vV361L37r0rUu/Xpe+jRG2AqUVKK1A2fpF9D3xIvoezMxOLu9PLj4tHJaZY5h7IT2EMjMsqsWm7Gp6JrNYUNjo2Su9pjL3Yvrq5lmEK+sy5lmoK1orGKgwa8mIIGspPc+CgNjwxHakRcn2McWZis0QwciCmFiW",
  "aqsW7WtYNwFkkGGk66qm68Z29+FtwSEK7IrNmRoF8w3ZqEHsZ+ThqMwqbGGMreJV6lRmHfYqQErm4agqsYq5NAwr8nBUk9hjvFLRFsrDybNiCC1TqoC2ZB6OAYm1y8LkB9zcyRoMSiBV/mSzsnAMVWHzFcrCFSHF9VmoOUaRyO1wFldCy+1x",
  "FlVCy61xFkbu5fY4p0eRyK1xFv1ku8S5NUxbw3S7pte2PNPyzBPjzDU25qUnXsHbQ9ntG6mZDvJ7DdDGTHspB3PZRbmMFVxA10P1NPcKN+Wuau4NN8UtiUyG++sKRCaXraxth75s4dCXCpgto6WX+1eiTl5GCm4Y7VW8bpVRib2dpZk9O/a0",
  "VoGTo5NXdvmkyH+V2z4p8l8f/+2T7eyXdvZLpiko3vDXw9mm4MIYh1wDvHMu90sTTmVDX0qDXXavH9MkdiwJpXMFq7GqWuvHsvPUao40dd6lfbUaf2ts5U+DJzNMpRpyzjK4xJvmmFpwuVqv4k1z62SnHLaO7O4wka1Tw/KwLRr2sXEsWfl8",
  "Deey0QX3ee48HeC10zjHAE7FElnYooTgvoE1jFWqAF0npgEtaiMTqNgwoapRkz+2s47mgObKdJvcKp1rYXSZAsuMUk5QvNJV+EsOpU9ecqjjrKvi9UA7P3+wu6uPX0lrmdnHV49vfj6//cXs9r3Z1etH39/2vjr+4M3jwzePDr+Z3f9mfu2T",
  "o+/ePvrur7OHb8zfvTe/enf+4EbOISgOED8cnOOkGnCuz/z2M46FyN9BV/HCnC6fwIhPcJxPjL6pY8XAhHMEQDYCCBt9ZhPEAFCQqlPIDGQbsLOOBGBzeYqGa9Cbyhw0WRPeWLl3vkruspvppUTApa+OHvxldv3eydef7kzO62Pb6g5t65w9",
  "zjvTAVbI/TDifhRyP4szf9+wIDJ1y9BV3cSWpSsmRtAySZ8gy1BVquO+ampGZx2xntqYH22NkmyEdt96MHvto/lXf9gZcr9x58Jo/JJLtsXrIVGFNIwiGsYhDZNTRTY3t4ZedYldKcKqb9l7OVOIiIWh9FKS1hKqrMyiybU0MjTb9GbbnGqc",
  "hpSLYpTrh3A3W0GXzhZIiZw6d9fkVFdsne8KNPqustTDq1E5sjkIMhfur4z27b2OH0Qd7J3zcB0djE0vuLc/fMUVD/7tXvBo8Mv4E/S9yQV77MIZPcU/4eBB+/Z4d+DGoNxlUlIufM3D7vOpq14swpUwfKQbg1vDZ/M9d9B67pX2YJcwUGsZ",
  "WZyT56NonXaqSHdGa6Kuw0RtMFTXhAO3zhb5fIZxD7WGcU7DuPoy33z2cS8K58BqXlmVVqu0pVhLhYyssuBH6VQeHfDTcQ9rsHIP1Y5//Q4ok6niDx9d2LPHPx2NneKTTgFx4J29nxrmoAen7X/ov2B9Mtrz89CDvcF0oA87wccv+DUQlz/k",
  "zpzn2LkVTaP90cQryUhaB/o+/+5l/xsXev6hyZ8VL0WKhvuZ+p5pD31SmJjcV3nGNQBDkuKE4pR+hYlqy38HL9mvBKteHALjYsRL6DeRJnQpf98Huj8Y2v8+HBnOPzsXbON0QCqnzdFwqBunHRh1cPoHP+jwqzmtDXY9PgLn3eoPD78AE9cT",
  "i1CDSdRqTX9EWAXASGMH09jBNHZwETuUxK6RAPkillAeS5TGEqWxRItY4iSWtURrF7FCwY6pHC8Rp9HDafTwInokgV6dgb1FJLE8bkSK/cgibjT56ipcL51AhMgjQqU4jS4iosrLkZICk///y2Bndu0jj1uLSUt1BSl6VoSDY0qfwQV9NrZ/",
  "fjAY27tcRb3oxRYWVRsXnBwZjwE9dnMI8/qNR+/d9eJSFeg7Blfqu+n4oFV3rbpr1V2r7lp1V1LdsSwRWe2C4ARm8dWesigyKTZj69PoO6oE5qxTtXJ31ftA3PWzFNvQ74bSKiLlZEuIpifAq+4BGTlexcrEnLaFIWVb9BZtix6UFNyVD1mN",
  "80lPXkEZUlZGb9HK6KEVQrz0rIQEPvL2hCFlT/QW7YkekRd0Mgoq0LRV+CnGKj37JPsprQBpBchGCBCcaQxW0TGcQCjwRfK8KSlfpIcbEo1Z2MkbtrLC0bX0OlNb33Xk43Aw8bqSzfP2rv6TmD3lXOGehfOHK9Im9piL0+fdoaKOxNrXjcGQ",
  "21m227Xmw/TUnjc5297TjaGTqnLkV5TQeWpiT0VfW/q5pxyjbdl3Y9vLOAq+dvBL/apvd5leXsnLk3HMXtwbTV/03lUo7vn3PwE7R4eXvBfqvStnSZnbhnp0eHV2m3Pd4ez2g44PjOGqkFK/9t3V2aXXT+5+5/2m5yI5v/nt3/jfnnpxdeW3",
  "Rw8/PH73952LYWd84Z/1Jajnch1eOr751fHvD0/u3vNwm1/7/OThLed3PM3lNBoX/inPnYsfHcdtfvnG7Dfvnzz4y9Hh9xz/+bXLRw8ue1fOP3zDxTCu90oeL3ewZtffO3nnjdmtr2fX35/f+pqz4vzO5U4qu+hX4E1fec57vl9i5/zegdvu",
  "/GrQEO22mZuj3f2hPbW9ZK1bg+eU5wV7pTtniEMl9sQcD/anA//kpVycIJv77B5/1dwceNZyGV7Rnbo3anahYZMu7lPW1ZFCuhoigCnUIAahDt+fH+3a0a1OVY3Mjac8n89igBCiWN0+wWYX67rVNQxGu33dpNQkABPbm6zgKl738eZQP7Ds",
  "7mjMRcdkOtadPHR4hYv4qx0usxyhEVsJQGDY+2/aA/FX3hsogot3pyuigEIvJktZDhx30+/vrc+5TS1BCNHyv3EtQudlRV6tu6u7DCVCISWqaUoslNFeK2HaTtcmUbuqiThhMsIvwxh2odJXCdD72MLkMSXMOuobilLnWZeUpvpg6NevtPZC",
  "ay88afZCNOyhldGtjN44Ge0Km8WgVxQqisI2ix5ivhzzWlPjjpmUTiMvRlzypZXXlRBP4QJF0ZZ8yeN1p79TOCVTxYsBl3yp46az3ilkcKcw95A0Dg2mtlOYkOJsQ9OY1JXIToGdTPgWYxWWhr+x/HUKIVacK9Q0HutOUjuV5o6xy20cT+c4",
  "2uc/k/oijLGqlmoT3UTdPkOwizEzugZT7C40GSA6BpppeHPdFx4C4w+hGJtEp1rXVlm/iymyOIEy2jVMy+wDZiPLVkUPQfGHmCqxkWqSrkoVxO0D/n8a1nAXqcwyma4Txdkjn34Ijj8EIgYYM40uAvycscYR02m/39U0TbeRTohJhA8hSUho",
  "HzOLGymqYXcxsQGHxNC6hg1sfixOX6TwTGj8IUBj2GYUdA1DB04shwPRB5hDYugKMpipIih6CIs/xFL7zAL8nTCkOmeickgsfjB9w0Z9plKK+krHCyWHHbFRk4GoQ0JUlZK2WuXNtf7BcOin6hxb6MXR3vAVf6BbOCBynOyb/XHQoxJZepoW",
  "/POFhRoXUb9Ck23ZC+OLY70jES5g0WoN/82vftaKOkzOgM5CE5DbzLPsVERPch3qxHPCzhR3CGJu8ssiF5AuFwxH/jRDN9iZJ7acbJiYbLAM2TQ3QGRxK1LNRIQknuRAsoSKylOkB9TZImI5ixqhsHi1NiLMM7zOI1WYRapYTKpQhlSbHwDm",
  "k6zbRz2wl0o+vJI6+oNfrCRYuvIpLouegSues2YWEj2IyD5oFW5s5YO8nvfEg+plammrT1LF1MrMOSa2eswMMpiZQTEzAxlmXtNAT5+j/dbjgtzs8SF4HPnQZ586LLQ060h7XbmMebghxjwRcweS4Y71zQv0GSSYUVIZhywTwhvIJdUQt7Qj",
  "n8vYwzUbe/Lz+WRYQBWzAJFggcanxCWWvVZk5j2BRC8ZMwrjNNFQMa+4OHOS2UU5/xx3wll+G6EKgALEjMDyW0p1z03b1kiPdIywrRdp60XaepG2urStLl1bdWmttSFGujakqXakxYxqr3hBiJEuCFlXE1IKq+KlIUa6NKTulqMU9MkenULp",
  "biNdBFJ7p1EKj+L1H0a6/qORdqIVGfleIiOv6H1L17kYVBWidjHUWVe1kRMbsqhNmGorDAsSx71ERr6PscL6FHexqfL/YzpwMn+0qwILcafW6mOtL3pIIiOvcOfXAJbWtaCiO46N1VVVm3X503RdQaapMiR6SCIjj0ygGAa/VUFI6WKgcKkO",
  "GUfM1PoIaybVnS1yxVPYPbgprg4Sujo9VCiHXcMExW11cKTJcBPyDDnmZrt5BpiVZ1DFkdQeKJ7frmf+cCXJhTZVuMZUYX2RMWl9lqcSpRdUovTQpoj/JbyKC0S66pn7mtpsWqEGEEtuOd2fMxPQA03VHkGY+cLFSeAeLBXjb2D4tVQ5UjXi",
  "+nERs/UWUsgZ62ede4YjUx/+KApsSTX9xMY2S8WAwuFTFy9ePPv/AQz0AcrFCAMA",
].join("");
export function parityResponses(): unknown {
  return JSON.parse(gunzipSync(Buffer.from(PARITY, "base64")).toString());
}

import { randomBytes } from "node:crypto";
import { sharedLedgerCommandDigest } from "../src/lib/shared-ledger-auth.ts";
import { SHARED_LEDGER_FEATURE_FIXTURE, SHARED_LEDGER_LIST_FIXTURE, SHARED_LEDGER_RESULT_FIXTURE } from "../src/lib/shared-ledger-contract-fixtures.ts";
import type { SharedLedgerJoinGrant } from "../src/lib/shared-ledger-join-protocol.ts";

interface InviteFixture { teamId?: string; projectId?: string; personId: string; role?: "member" | "service"; actions?: ("read" | "plan" | "import" | "project")[] }

/** Canned enrollment responses; this mock never verifies signatures, runs a center domain or accesses a database. */
export class EnrollmentResponses {
  readonly centerId = `center-${randomBytes(16).toString("hex")}`;
  readonly deniedCodes = new Set<string>();
  readonly grants = new Map<string, SharedLedgerJoinGrant>();
  readonly features = new Map<string, typeof SHARED_LEDGER_FEATURE_FIXTURE>();
  readonly commands: any[] = [];
  readonly server: ReturnType<typeof Bun.serve>;
  constructor() {
    this.server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.respond(request) });
  }
  get url() { return this.server.url.toString(); }
  invite(input: InviteFixture): { ok: true; joinCode: string } {
    const code = `sljoin1.${this.centerId}.${randomBytes(16).toString("hex")}.${randomBytes(32).toString("base64url")}`;
    this.grants.set(code, { centerId: this.centerId, teamId: input.teamId ?? "team-a", personId: input.personId,
      instanceId: "fixture-instance", bearer: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000,
      role: input.role ?? "member", projects: [{ projectId: input.projectId ?? "project-a", actions: input.actions ?? ["read", "plan"] }] });
    return { ok: true, joinCode: code };
  }
  close() { this.server.stop(true); }
  private list(grant: SharedLedgerJoinGrant) {
    return { ...structuredClone(SHARED_LEDGER_LIST_FIXTURE), teamId: grant.teamId,
      features: [...this.features.values()].filter(item => item.feature.projectId === grant.projects[0]!.projectId).map(item => item.feature) };
  }
  private command(grant: SharedLedgerJoinGrant, payload: any) {
    this.commands.push(structuredClone(payload));
    if (payload.type !== "feature.new") return Response.json({ code: "unexpected_fixture_command" }, { status: 400 });
    const item = structuredClone(SHARED_LEDGER_FEATURE_FIXTURE), id = `fixture-${randomBytes(8).toString("hex")}`;
    item.feature = { ...item.feature, id, projectId: payload.projectId, title: payload.title, description: payload.description,
      homeInstanceId: payload.homeInstanceId, updatedBy: grant.personId };
    item.feature.projection!.sourceInstanceId = payload.homeInstanceId;
    this.features.set(id, item);
    return Response.json({ ...structuredClone(SHARED_LEDGER_RESULT_FIXTURE), requestId: payload.requestId,
      commandDigest: sharedLedgerCommandDigest({ attemptNonce: "00".repeat(16), payload }), result: { featureId: id, rev: item.feature.rev, version: item.feature.version } });
  }
  async respond(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/v1/join" && request.method === "POST") {
      const input = await request.json() as { code: string; instanceId: string };
      const grant = this.grants.get(input.code);
      if (!grant || this.deniedCodes.has(input.code)) return Response.json({ code: "join_rejected", message: "Join rejected" }, { status: 403 });
      grant.instanceId = input.instanceId;
      return Response.json(grant);
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "");
    const grant = [...this.grants.values()].find(item => item.bearer === bearer);
    if (!grant) return Response.json({ code: "not_member" }, { status: 403 });
    if (path.endsWith("/features")) return Response.json(this.list(grant));
    if (path.includes("/features/")) {
      const item = this.features.get(path.split("/").at(-1)!);
      if (!item || item.feature.projectId !== grant.projects[0]!.projectId) return Response.json({ code: "fixture_refusal" }, { status: 403 });
      return Response.json({ ...item, teamId: grant.teamId });
    }
    if (path.includes("/commands/") && request.method === "GET") return Response.json({ status: "unknown", requestId: path.split("/").at(-1) });
    if (path.endsWith("/commands") && request.method === "POST") return this.command(grant, (await request.json() as { payload: unknown }).payload);
    return Response.json({ code: "unexpected_fixture_request" }, { status: 404 });
  }
}

const C6_DATA = [
  "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",
].join("");
export function c6Responses(caseId: string): any[] {
  const cases = JSON.parse(gunzipSync(Buffer.from(C6_DATA, "base64")).toString());
  if (!(caseId in cases)) throw new Error(`unknown C6 response fixture: ${caseId}`);
  return cases[caseId];
}

function fixtureVariable(value: unknown, key: string): boolean {
  return typeof value === "number" && value > 1_000_000_000_000
    || typeof value === "string" && (key === "requestId" || /^[a-f0-9-]{36}$|^[a-f0-9]{64}$/.test(value));
}
function bindFixture(expected: any, actual: any, variables: Map<unknown, unknown>, key = ""): boolean {
  if (fixtureVariable(expected, key)) {
    if (typeof expected !== typeof actual) return false;
    if (variables.has(expected) && variables.get(expected) !== actual && typeof expected !== "number") return false;
    variables.set(expected, actual);
    return true;
  }
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length
    && expected.every((value, index) => bindFixture(value, actual[index], variables, key));
  if (expected && typeof expected === "object") return actual && typeof actual === "object"
    && Object.keys(expected).length === Object.keys(actual).length
    && Object.entries(expected).every(([name, value]) => name in actual && bindFixture(value, actual[name], variables, name));
  return expected === actual;
}
function fixtureSubstitute(value: any, variables: Map<unknown, unknown>): any {
  if (variables.has(value)) return variables.get(value);
  if (Array.isArray(value)) return value.map(item => fixtureSubstitute(item, variables));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fixtureSubstitute(item, variables)]));
  return value;
}

/** A generic finite response tape, not a ledger state machine. Unrecorded requests fail the test immediately. */
export class RecordedResponses {
  private used = new Set<number>();
  private variables = new Map<unknown, unknown>();
  private last = new Map<string, any>();
  constructor(private calls: any[]) {}
  async respond(request: Request, person: string | null): Promise<Response> {
    const path = new URL(request.url).pathname;
    const payload = request.method === "GET" ? null : (await request.json() as { payload: unknown }).payload;
    const instanceId = request.headers.get("x-claudestra-instance") ?? request.headers.get("x-shared-ledger-instance");
    const tag = `${person}:${request.method}:${path}`;
    for (const [index, call] of this.calls.entries()) {
      if (this.used.has(index) || call.person !== person || call.method !== request.method || call.instanceId !== instanceId) continue;
      const variables = new Map(this.variables);
      const recordedPath = fixtureSubstitute(call.path, variables);
      if (recordedPath !== path || !bindFixture(call.payload, payload, variables)) continue;
      this.used.add(index); this.variables = variables;
      const result = fixtureSubstitute(call.result, variables);
      this.last.set(tag, result);
      return Response.json(result.body, { status: result.status });
    }
    const repeated = this.last.get(tag);
    if (request.method === "GET" && repeated) return Response.json(repeated.body, { status: repeated.status });
    throw new Error(`unrecorded fixture request: ${person} ${request.method} ${path}`);
  }
}

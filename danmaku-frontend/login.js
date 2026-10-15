// 规定登录栏的行为

const login_check_url = "/backend/login/login_check"
const logout_url = "/backend/login/logout"

// 登录检验函数
function login_check() {
    return new Promise(function(resolve, reject) {
        $.ajax({
            url: login_check_url,
            method: 'GET',
            dataType: 'json',
            xhrFields: {
                withCredentials: true
            },
            crossDomain: true,
            success: function(data) {
                /*
                返回值：
                0：正确login
                1：没有login
                2：此次登陆状态被其他地方的登录顶掉了
                5：恶意攻击
                6：查询数据库错误
                */

                resolve(data);
            },
            error: function(xhr, status, error) {
                reject(xhr, status, error);
            }
        });
    });
}

function logout() {
    $.ajax({
        url: logout_url, // 请求的URL
        method: 'POST', // 请求方法
        dataType: 'json', //预期数据类型
        xhrFields: {
            withCredentials: true // 启用会话 cookie
        },
        crossDomain: true, // 明确指示这是跨域请求
        success: function(data) {
            /*
            '''
            返回值：
            0：正确login
            1：没有login
            2：此次登陆状态被其他地方的登录顶掉了
            5：恶意攻击
            6：查询数据库错误
            '''
            */
    
            console.log(data)
    
            document.getElementById("to_login").style.display=""
            document.getElementById("has_login").style.display="none"
            location.reload()
        },
        error: function(xhr, status, error) {
            // 处理请求错误
            reject(xhr, status, error);
        }
    });
}

function do_after_login_check(templateDOM, contentDOM, result) {
    var toLoginElement = templateDOM.getElementById("to_login");
    var hasLoginElement = templateDOM.getElementById("has_login");

    // 处理登陆问题
    if (result.status === 'fulfilled') {
        if (result.value.status === 0) {
            toLoginElement.style.display = "none"
            hasLoginElement.style.display = ""

            templateDOM.getElementById("username_block").innerHTML = result.value.username_login
        }
    }
    else {
        if (toLoginElement) {
            toLoginElement.parentNode.removeChild(toLoginElement);
        }
        if (hasLoginElement) {
            hasLoginElement.parentNode.removeChild(hasLoginElement);
        }
        templateDOM.getElementById("login_template").style.backgroundImage = 'none'
    }

    var dark_theme = getCookie("dark_theme");
    var theme_changing_button = templateDOM.querySelector("#nav_bar > a")

    if (dark_theme === "" || dark_theme === "light") {
        setCookie("dark_theme", "light")
        if (theme_changing_button) {
            theme_changing_button.title = "切换至露娜"
        }
    } else {
        document.body.classList.add("dark")
        if (theme_changing_button) {
            theme_changing_button.title = "切换至桑尼"
        }
    }
}

function setCookie(cname, cvalue, exdays = 365) {
    const d = new Date();
    d.setTime(d.getTime() + (exdays*24*60*60*1000));
    let expires = "expires="+ d.toUTCString();
    document.cookie = cname + "=" + cvalue + ";" + expires + ";path=/";
  }

function getCookie(cname) {
    let name = cname + "=";
    let decodedCookie = decodeURIComponent(document.cookie);
    let ca = decodedCookie.split(';');
    for(let i = 0; i <ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') {
        c = c.substring(1);
        }
        if (c.indexOf(name) == 0) {
        return c.substring(name.length, c.length);
        }
    }
    return "";
}